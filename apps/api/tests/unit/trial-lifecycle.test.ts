/**
 * The trial clock, tested for the two things that actually go wrong with a daily worker.
 *
 * ONE: IDEMPOTENCE. This runs every day over every workspace on the deployment, so the failure to
 * design against is not "it missed a day" — it is "it sent the 7-day warning on all seven days".
 * Every notice is recorded and every transition is guarded on the status it moves FROM, and these
 * tests drive the tick twice to prove the second pass does nothing.
 *
 * TWO: THE BOUNDARIES. A trial expiring in six hours must warn as "1 day", not "0"; a trial that
 * has expired must move to GRACE and not straight to SUSPENDED; a workspace in GRACE must not be
 * suspended until the window has actually elapsed.
 *
 * Deliberately NOT tested here: that entitlements lapse on time. They do not depend on this worker
 * at all — `plan-limits.service.ts#effectiveTier` compares against the clock on every read, which
 * is covered where that lives. Testing it here would suggest the worker is what enforces a trial,
 * which is exactly the misunderstanding the worker's header warns about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const orgs: any[] = [];

const findMany = vi.fn(async ({ where }: any) => {
  const now = Date.now();
  return orgs.filter((o) => {
    if (where.status && o.status !== where.status) return false;
    if (where.trialEndsAt?.gt && !(o.trialEndsAt && o.trialEndsAt.getTime() > where.trialEndsAt.gt.getTime())) return false;
    if (where.trialEndsAt?.lte && !(o.trialEndsAt && o.trialEndsAt.getTime() <= where.trialEndsAt.lte.getTime())) return false;
    if (where.graceStartedAt?.lte && !(o.graceStartedAt && o.graceStartedAt.getTime() <= where.graceStartedAt.lte.getTime())) return false;
    return true;
  });
});
const update = vi.fn(async ({ where, data }: any) => {
  const org = orgs.find((o) => o.id === where.id);
  Object.assign(org, data);
  return org;
});

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { organization: { findMany: (...a: any[]) => findMany(...(a as [any])), update: (...a: any[]) => update(...(a as [any])) } }
}));

const mailed: Array<{ slug: string; key: string }> = [];
vi.mock("../../src/config/with-org-tenant.js", () => ({
  withOrgTenant: async (slug: string, fn: () => Promise<unknown>) => {
    (globalThis as any).__slug = slug;
    return fn();
  }
}));
vi.mock("../../src/config/prisma.js", () => ({
  prisma: { user: { findMany: async () => [{ email: "admin@acme.com" }] } }
}));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchTransactional: async (args: { templateKey: string }) => {
    mailed.push({ slug: (globalThis as any).__slug, key: args.templateKey });
    return { ok: true };
  }
}));
vi.mock("../../src/services/org-status.service.js", () => ({ forgetOrgStatus: vi.fn() }));

const { runTrialLifecycleTick } = await import("../../src/workers/trial-lifecycle.worker.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-27T09:00:00Z").getTime();

function seed(overrides: Partial<Record<string, unknown>> = {}) {
  orgs.length = 0;
  mailed.length = 0;
  orgs.push({
    id: "org-1",
    slug: "acme",
    name: "Acme",
    status: "ACTIVE",
    trialEndsAt: null,
    graceStartedAt: null,
    trialNoticesSent: null,
    ...overrides
  });
  return orgs[0];
}

beforeEach(() => {
  findMany.mockClear();
  update.mockClear();
});

describe("warnings", () => {
  it("warns once at each threshold and never twice for the same one", async () => {
    const org = seed({ trialEndsAt: new Date(NOW + 3 * DAY) });

    expect((await runTrialLifecycleTick(NOW)).warned).toBe(1);
    expect(mailed).toEqual([{ slug: "acme", key: "billing.trial_ending" }]);
    expect(org.trialNoticesSent).toEqual([3]);

    // The same day again — a re-run, a restart, a second instance. Must be silent.
    mailed.length = 0;
    expect((await runTrialLifecycleTick(NOW)).warned).toBe(0);
    expect(mailed).toEqual([]);
  });

  it("counts a trial ending in six hours as one day left, not zero", async () => {
    const org = seed({ trialEndsAt: new Date(NOW + 6 * 60 * 60 * 1000) });
    await runTrialLifecycleTick(NOW);
    // "0 days left" is both wrong and alarming for something that has not happened yet.
    expect(org.trialNoticesSent).toEqual([1]);
  });

  it("sends the closest threshold, not every threshold it has passed", async () => {
    // A workspace whose first tick happens with 2 days left has passed 7 and 3 as well. It should
    // get ONE email saying 2 days, not a burst of three.
    const org = seed({ trialEndsAt: new Date(NOW + 2 * DAY) });
    await runTrialLifecycleTick(NOW);
    expect(mailed).toHaveLength(1);
    expect(org.trialNoticesSent).toEqual([3]);
  });

  it("says nothing while the trial is still far off", async () => {
    seed({ trialEndsAt: new Date(NOW + 30 * DAY) });
    expect((await runTrialLifecycleTick(NOW)).warned).toBe(0);
    expect(mailed).toEqual([]);
  });

  it("leaves a workspace with no trial entirely alone", async () => {
    // Every org provisioned by hand — which is all of them today — has a null trialEndsAt. A null
    // must read as "no trial", never as "expired".
    const org = seed({ trialEndsAt: null });
    const result = await runTrialLifecycleTick(NOW);
    expect(result).toEqual({ warned: 0, lapsed: 0, suspended: 0 });
    expect(org.status).toBe("ACTIVE");
  });
});

describe("expiry and suspension", () => {
  it("moves an expired trial to GRACE, not to SUSPENDED", async () => {
    const org = seed({ trialEndsAt: new Date(NOW - 1000) });
    expect((await runTrialLifecycleTick(NOW)).lapsed).toBe(1);
    expect(org.status).toBe("GRACE");
    expect(org.graceStartedAt).toBeInstanceOf(Date);
    expect(mailed).toEqual([{ slug: "acme", key: "billing.trial_ended" }]);
  });

  it("does not lapse the same workspace twice", async () => {
    seed({ trialEndsAt: new Date(NOW - 1000) });
    await runTrialLifecycleTick(NOW);
    mailed.length = 0;
    expect((await runTrialLifecycleTick(NOW)).lapsed).toBe(0);
    expect(mailed).toEqual([]);
  });

  it("leaves a workspace in GRACE alone until the window has actually elapsed", async () => {
    const org = seed({ status: "GRACE", graceStartedAt: new Date(NOW - 13 * DAY) });
    expect((await runTrialLifecycleTick(NOW)).suspended).toBe(0);
    expect(org.status).toBe("GRACE");
  });

  it("suspends once the grace window is up", async () => {
    const org = seed({ status: "GRACE", graceStartedAt: new Date(NOW - 15 * DAY) });
    expect((await runTrialLifecycleTick(NOW)).suspended).toBe(1);
    expect(org.status).toBe("SUSPENDED");
    expect(org.suspendedAt).toBeInstanceOf(Date);
  });
});
