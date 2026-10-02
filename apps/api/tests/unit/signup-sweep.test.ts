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

type Org = {
  id: string;
  slug: string;
  name: string;
  status: string;
  createdVia: string | null;
  ownerEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The OrgDatabase row — its encrypted DSN — once provisioning has registered one. */
  database: { id: string } | null;
};
type Where = { id?: string; status?: string; createdVia?: string; createdAt?: { lt: Date }; updatedAt?: { lt: Date }; database?: { is: null } | null };
const m = vi.hoisted(() => ({
  orgs: [] as Org[],
  audit: vi.fn(async () => undefined),
  stage: vi.fn(async () => undefined)
}));

/** The `where` the sweep sends, read the way MySQL would — every field it names has to hold. */
function matches(o: Org, where: Where): boolean {
  if (where.id !== undefined && o.id !== where.id) return false;
  if (where.status !== undefined && o.status !== where.status) return false;
  if (where.createdVia !== undefined && o.createdVia !== where.createdVia) return false;
  if (where.createdAt && !(o.createdAt < where.createdAt.lt)) return false;
  if (where.updatedAt && !(o.updatedAt < where.updatedAt.lt)) return false;
  if (where.database !== undefined && o.database !== null) return false;
  return true;
}

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    organization: {
      findMany: vi.fn(async ({ where }: { where: Where }) => m.orgs.filter((o) => matches(o, where))),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const index = m.orgs.findIndex((o) => matches(o, where));
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
  // Untouched since signup created it — the interrupted request never wrote to it again.
  updatedAt: new Date(now.getTime() - minutesAgo * MINUTE),
  database: null,
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

  /*
   * AN OPERATOR'S HANDS ON THE ROW. Old is not the same as abandoned: an operator provisioning a stuck
   * signup by hand is working on a row created long ago, and deleting it mid-run cascades to the DSN
   * row the run is about to write, the domain claim and the Stripe ids — and orphans the database.
   */
  it("leaves an old signup alone while somebody is working on it — its row was written inside the threshold", async () => {
    m.orgs = [org("in-hand", 60 * 24, { updatedAt: new Date(now.getTime() - 2 * MINUTE) })];

    expect((await sweepAbandonedSignups(now)).removed).toEqual([]);
    expect(m.orgs).toHaveLength(1);
  });

  it("never removes a workspace whose database is registered — that row holds the only copy of its DSN", async () => {
    m.orgs = [org("registered", 60 * 24, { database: { id: "db-1" } })];

    expect((await sweepAbandonedSignups(now)).removed).toEqual([]);
    expect(m.orgs).toHaveLength(1);
  });

  it("does not delete a row somebody started provisioning between the sweep's read and its delete", async () => {
    const touched = org("touched", STALE_PROVISIONING_MINUTES + 5);
    m.orgs = [touched];
    const { controlPrisma } = await import("../../src/config/control-prisma.js");
    vi.mocked(controlPrisma.organization.findMany).mockImplementationOnce(async () => {
      const rows = [{ ...touched }];
      touched.updatedAt = now; // provisionOrganization marks the row as it starts
      return rows as never;
    });

    expect((await sweepAbandonedSignups(now)).removed).toEqual([]);
    expect(m.orgs).toHaveLength(1);
  });
});
