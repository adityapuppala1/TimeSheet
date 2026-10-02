/**
 * The cron workers, as a deployment of more than one replica actually runs them.
 *
 * `job-claim.test.ts` pins the mechanism. This file pins that the workers USE it:
 *  - two copies of the trial-lifecycle worker — two pods, each with its own module state and its
 *    own `running` flag — firing the same 09:00 tick send ONE "your trial ends in 3 days" email;
 *  - every worker server.ts starts schedules its ticks through `runOncePerTick`, so the next worker
 *    somebody adds cannot quietly go back to once-per-replica.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  claims: [] as Array<{ job: string; periodKey: string; claimedAt: Date }>,
  scheduled: [] as Array<{ expression: string; fn: () => unknown }>,
  mailed: [] as string[],
  orgs: [] as Array<Record<string, unknown>>
}));

vi.mock("node-cron", () => ({
  default: {
    schedule: (expression: string, fn: () => unknown) => {
      state.scheduled.push({ expression, fn });
      return { stop: () => undefined };
    },
    validate: () => true
  }
}));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    organization: {
      findMany: async ({ where }: { where: { status?: string; trialEndsAt?: { gt?: Date; lte?: Date }; graceStartedAt?: { lte: Date } } }) =>
        state.orgs.filter((o) => {
          if (where.status && o.status !== where.status) return false;
          const ends = o.trialEndsAt as Date | null;
          if (where.trialEndsAt?.gt && !(ends && ends > where.trialEndsAt.gt)) return false;
          if (where.trialEndsAt?.lte && !(ends && ends <= where.trialEndsAt.lte)) return false;
          if (where.graceStartedAt) return false;
          return true;
        }),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(state.orgs.find((o) => o.id === where.id)!, data)
    },
    platformRetentionSettings: { findUnique: async () => null, create: async () => ({ enabled: false, feedbackDay: 10, reminderDays: [30], retentionDays: 90, autoDeleteEnabled: false, snapshotDir: null, updatedAt: new Date() }) },
    platformJobClaim: {
      createMany: async ({ data }: { data: Array<{ job: string; periodKey: string; claimedAt?: Date }> }) => {
        await Promise.resolve();
        let count = 0;
        for (const entry of data) {
          if (state.claims.some((c) => c.job === entry.job && c.periodKey === entry.periodKey)) continue;
          state.claims.push({ job: entry.job, periodKey: entry.periodKey, claimedAt: entry.claimedAt ?? new Date() });
          count += 1;
        }
        return { count };
      },
      deleteMany: async ({ where }: { where: { job?: string; periodKey?: string; claimedAt?: Date | { lt: Date } } }) => {
        await Promise.resolve();
        const before = state.claims.length;
        state.claims = state.claims.filter((c) => {
          const hit =
            (where.job === undefined || c.job === where.job) &&
            (where.periodKey === undefined || c.periodKey === where.periodKey) &&
            (where.claimedAt === undefined ||
              (where.claimedAt instanceof Date ? c.claimedAt.getTime() === where.claimedAt.getTime() : c.claimedAt < where.claimedAt.lt));
          return !hit;
        });
        return { count: before - state.claims.length };
      },
      updateMany: async () => ({ count: 1 })
    }
  }
}));
vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant: async (_slug: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("../../src/config/prisma.js", () => ({ prisma: { user: { findMany: async () => [{ email: "admin@acme.com" }] } } }));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchTransactional: async (args: { templateKey: string }) => {
    state.mailed.push(args.templateKey);
    return { ok: true };
  }
}));
vi.mock("../../src/services/org-status.service.js", () => ({ forgetOrgStatus: () => undefined }));

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  state.claims = [];
  state.scheduled = [];
  state.mailed = [];
  state.orgs = [{ id: "org-1", slug: "acme", name: "Acme", status: "ACTIVE", planTier: "STARTER", trialTier: "TEAM", stripeSubscriptionId: null, trialEndsAt: new Date(Date.now() + 3 * DAY), graceStartedAt: null, trialNoticesSent: null }];
});

describe("two replicas of a cron worker", () => {
  it("send the trial warning once, not once per pod", async () => {
    // Two pods: two independent module instances, each with its own `started`/`running` flags —
    // which is exactly why the in-process guard never stopped this.
    for (let pod = 0; pod < 2; pod += 1) {
      vi.resetModules();
      const { startTrialLifecycleWorker } = await import("../../src/workers/trial-lifecycle.worker.js");
      startTrialLifecycleWorker();
    }
    expect(state.scheduled).toHaveLength(2);

    // The same 09:00 fires on both at once.
    await Promise.all(state.scheduled.map(({ fn }) => fn()));

    expect(state.mailed).toEqual(["billing.trial_ending"]);
  });
});

describe("every scheduled worker goes through runOncePerTick", () => {
  const apiSrc = path.resolve(fileURLToPath(new URL("../../src", import.meta.url)));
  const server = fs.readFileSync(path.join(apiSrc, "server.ts"), "utf8");
  const started = [...server.matchAll(/import \{ (start\w+Worker) \} from "\.\/workers\/([\w-]+)\.worker\.js";/g)]
    .map(([, fn, file]) => ({ fn, file }))
    .filter(({ fn }) => new RegExp(`\\b${fn}\\(\\)`).test(server));

  it("finds the workers server.ts starts", () => {
    expect(started.length).toBeGreaterThan(25);
  });

  it.each(started.map(({ file }) => [file]))("%s claims each tick for the deployment", (file) => {
    const source = fs.readFileSync(path.join(apiSrc, "workers", `${file}.worker.ts`), "utf8");
    const schedules = source.match(/cron\.schedule\(/g)?.length ?? 0;
    const claimed = source.match(/runOncePerTick\(/g)?.length ?? 0;
    expect(schedules, `${file} schedules nothing`).toBeGreaterThan(0);
    expect(claimed, `${file}.worker.ts schedules ${schedules} tick(s) but claims ${claimed}`).toBeGreaterThanOrEqual(schedules);
  });
});
