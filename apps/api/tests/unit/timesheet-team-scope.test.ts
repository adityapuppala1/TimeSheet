/**
 * `teamScopeUserIds` — who `GET /timesheets?scope=team` returns, which drives the home page's day
 * timeline.
 *
 * This is a VISIBILITY CONTROL, so the negative cases carry the weight: a manager must not be able
 * to see people who do not report to them, and an employee must not be able to see anyone else. It
 * exists because the obvious check — `REPORTS_VIEW` — is the WRONG instrument here: that permission
 * is granted to MANAGER and TEAM_LEAD as well as the admin roles, so the timeline was showing a
 * manager every person in the company.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "@timesheet/shared";

import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { teamScopeUserIds } = await import("../../src/controllers/timesheet.controller.js");

function client(reports: Array<{ id: string }> = []) {
  const c = createFakeTenantClient();
  vi.mocked(c.user.findMany).mockResolvedValue(reports as never);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("teamScopeUserIds", () => {
  it("returns undefined — no restriction — for an admin", async () => {
    const c = client();
    const scope = await runInTenant(c, () =>
      teamScopeUserIds({ id: "admin-1", permissions: [permissions.USERS_MANAGE, permissions.REPORTS_VIEW] })
    );

    expect(scope).toBeUndefined();
    // Not even looked up: `users:manage` is the whole answer, so the reporting line is irrelevant.
    expect(c.user.findMany).not.toHaveBeenCalled();
  });

  it("gives a manager their direct reports AND themselves", async () => {
    const c = client([{ id: "report-a" }, { id: "report-b" }]);
    const scope = await runInTenant(c, () =>
      // REPORTS_VIEW is deliberately present: a manager HAS it, and it must not widen this.
      teamScopeUserIds({ id: "mgr-1", permissions: [permissions.REPORTS_VIEW, permissions.TIMESHEETS_APPROVE] })
    );

    expect(scope).toEqual({ in: ["mgr-1", "report-a", "report-b"] });
    expect(c.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { managerId: "mgr-1", deletedAt: null } })
    );
  });

  it("gives someone who manages nobody only themselves", async () => {
    const c = client([]);
    const scope = await runInTenant(c, () => teamScopeUserIds({ id: "emp-1", permissions: [permissions.TIMESHEETS_WRITE] }));

    // The employee case is not a separate branch — it is the manager branch with an empty team.
    expect(scope).toEqual({ in: ["emp-1"] });
  });

  it("excludes soft-deleted reports", async () => {
    // Asserted on the QUERY rather than the result: a departed report's entries must not reappear
    // in their old manager's timeline, and `deletedAt: null` is the only thing preventing it.
    const c = client([{ id: "report-a" }]);
    await runInTenant(c, () => teamScopeUserIds({ id: "mgr-1", permissions: [] }));

    const where = vi.mocked(c.user.findMany).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(where.where.deletedAt).toBeNull();
  });
});
