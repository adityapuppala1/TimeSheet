/**
 * A self-serve signup interrupted mid-provisioning is cleaned up, as the signup failure path would
 * have cleaned it up had it got the chance.
 *
 * THE GAP. /complete commits the workspace row and its company-domain claim, spends the continuation,
 * and only then provisions — cleanup lives in the request's `catch`. A pod killed in between (a deploy,
 * an HPA scale-down) left the row PROVISIONING forever: the slug taken, and the company's domain
 * claimed by a workspace that will never open — so the owner, and every colleague after them, was
 * told "your company's workspace is unavailable" with no way forward.
 *
 * THE LINE IT MUST NOT CROSS. A console-created workspace waits in PROVISIONING for an operator, for
 * as long as the operator likes — it is never touched. Neither is a signup still inside the window a
 * real provisioning takes, nor one that finished while the sweep was looking at it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Org = { id: string; slug: string; name: string; status: string; createdVia: string | null; ownerEmail: string | null; createdAt: Date };
const m = vi.hoisted(() => ({
  orgs: [] as Org[],
  audit: vi.fn(async () => undefined),
  stage: vi.fn(async () => undefined)
}));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    organization: {
      findMany: vi.fn(async ({ where }: { where: { status: string; createdVia: string; createdAt: { lt: Date } } }) =>
        m.orgs.filter((o) => o.status === where.status && o.createdVia === where.createdVia && o.createdAt < where.createdAt.lt)
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; status: string } }) => {
        const index = m.orgs.findIndex((o) => o.id === where.id && o.status === where.status);
        if (index < 0) return { count: 0 };
        m.orgs.splice(index, 1);
        return { count: 1 };
      })
    }
  }
}));
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit: m.audit }));
vi.mock("../../src/services/signup-funnel.service.js", () => ({ recordSignupStage: m.stage }));

const { STALE_PROVISIONING_MINUTES, sweepAbandonedSignups } = await import("../../src/services/signup-sweep.service.js");

const MINUTE = 60_000;
const now = new Date("2026-10-02T10:00:00Z");
const org = (id: string, minutesAgo: number, overrides: Partial<Org> = {}): Org => ({
  id,
  slug: id,
  name: `Workspace ${id}`,
  status: "PROVISIONING",
  createdVia: "SELF_SERVE",
  ownerEmail: `owner@${id}.example`,
  createdAt: new Date(now.getTime() - minutesAgo * MINUTE),
  ...overrides
});

beforeEach(() => {
  m.orgs = [];
  vi.clearAllMocks();
});

describe("sweepAbandonedSignups", () => {
  it("removes a self-serve signup stuck in PROVISIONING past the threshold — its claim goes with the row", async () => {
    m.orgs = [org("stuck", STALE_PROVISIONING_MINUTES + 5)];

    const result = await sweepAbandonedSignups(now);

    expect(result.removed).toEqual(["stuck"]);
    expect(m.orgs).toEqual([]);
    expect(m.audit).toHaveBeenCalledWith("SYSTEM", "scheduler", "org.signup_abandoned", "Organization", "stuck", expect.objectContaining({ slug: "stuck" }));
    expect(m.stage).toHaveBeenCalledWith("FAILED", expect.objectContaining({ email: "owner@stuck.example" }));
  });

  it("leaves a signup that may still be provisioning", async () => {
    m.orgs = [org("fresh", STALE_PROVISIONING_MINUTES - 5)];
    expect((await sweepAbandonedSignups(now)).removed).toEqual([]);
    expect(m.orgs).toHaveLength(1);
  });

  it("never touches a workspace an operator created, however long it has waited", async () => {
    m.orgs = [org("console", 60 * 24 * 30, { createdVia: "CONSOLE" }), org("legacy", 60 * 24 * 30, { createdVia: null })];
    expect((await sweepAbandonedSignups(now)).removed).toEqual([]);
    expect(m.orgs).toHaveLength(2);
  });

  it("does not delete a signup that finished provisioning while the sweep was looking at it", async () => {
    const racing = org("racing", STALE_PROVISIONING_MINUTES + 5);
    m.orgs = [racing];
    const { controlPrisma } = await import("../../src/config/control-prisma.js");
    vi.mocked(controlPrisma.organization.findMany).mockImplementationOnce(async () => {
      const rows = [{ ...racing }];
      racing.status = "ACTIVE"; // the request's provisionOrganization flips it now
      return rows as never;
    });

    expect((await sweepAbandonedSignups(now)).removed).toEqual([]);
    expect(m.orgs[0].status).toBe("ACTIVE");
    expect(m.audit).not.toHaveBeenCalled();
  });
});
