/**
 * Deactivating somebody removes their numbers from the screens, and from NOTHING else.
 *
 * Both halves of that sentence are load-bearing, and they fail in opposite directions:
 *
 *   - Too little, and the complaint that started this comes back — a departed colleague still
 *     holding first place on the leaderboard, still occupying a lane in the workload heatmap, still
 *     on their old manager's team page with a clickable hours trend.
 *   - Too much, and it becomes a data-loss bug wearing a feature's clothes. Exports would quietly
 *     drop a leaver's hours from a quarter somebody is invoicing against; workspace totals would
 *     shrink for a reason nothing on the page explains; the audit trail would forget who did what.
 *     That is far worse than the bug being fixed, and it is silent.
 *
 * So this file drives the real routers over a fake directory containing one of every kind of
 * person, and asks each screen who it named. The DIRECTORY IS REAL ENOUGH TO FILTER — the stand-in
 * evaluates the `where` clauses rather than returning a canned list — because a test that asserts
 * the shape of a query only proves a query was written, not that the right rows come back.
 *
 * Three assertions here are worth more than the rest, and each pins a decision that is easy to
 * reverse by accident:
 *   1. A PENDING_VERIFICATION invitee is still shown. The predicate is "not deactivated", not "is
 *      ACTIVE" — the first draft of this feature used the latter and would have made every new
 *      joiner invisible on their manager's team page until they clicked a verification link.
 *   2. Workspace TOTALS still count a hidden person's work. Their tickets are still open and their
 *      hours were still worked; only the named row goes.
 *   3. The export path still resolves an inactive reviewer's name, and its `where` builder carries
 *      no status predicate at all.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Person = {
  id: string;
  name: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION";
  deletedAt: Date | null;
  managerId: string | null;
};

const MANAGER = "user-manager";

/**
 * One of every kind of person. `RAVI` is soft-deleted while still carrying `status: "ACTIVE"` on
 * purpose: the two signals are written together today, but `deletedAt` is the older of them, and a
 * predicate that only checked the status would pass this suite while leaving deleted people on
 * screen.
 */
const ASHA: Person = { id: "user-asha", name: "Asha Rao", status: "ACTIVE", deletedAt: null, managerId: MANAGER };
const BEN: Person = { id: "user-ben", name: "Ben Cole", status: "ACTIVE", deletedAt: null, managerId: MANAGER };
const NEW_JOINER: Person = {
  id: "user-joiner",
  name: "Priya Nair",
  status: "PENDING_VERIFICATION",
  deletedAt: null,
  managerId: MANAGER
};
const DANA: Person = { id: "user-dana", name: "Dana Fell", status: "INACTIVE", deletedAt: null, managerId: MANAGER };
const RAVI: Person = {
  id: "user-ravi",
  name: "Ravi Menon",
  status: "ACTIVE",
  deletedAt: new Date("2026-01-05T00:00:00.000Z"),
  managerId: MANAGER
};
const DIRECTORY = [ASHA, BEN, NEW_JOINER, DANA, RAVI];

/** Everyone a screen should still name. */
const SHOWN = [ASHA, BEN, NEW_JOINER];
/** Everyone a screen should stop naming. */
const HIDDEN = [DANA, RAVI];

const state = vi.hoisted(() => ({
  tickets: [] as Array<Record<string, unknown>>,
  timesheets: [] as Array<Record<string, unknown>>,
  leaderboardEnabled: true
}));

/** Evaluates only the `where` shapes this code actually writes. Anything unrecognised is loud
 *  rather than ignored — a silently-unsupported operator would make the whole file vacuous. */
function personMatches(person: Person, where: Record<string, any> | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    switch (key) {
      case "id":
        if (typeof condition === "string") {
          if (person.id !== condition) return false;
        } else if (Array.isArray(condition?.in)) {
          if (!condition.in.includes(person.id)) return false;
        } else {
          throw new Error(`unsupported id condition: ${JSON.stringify(condition)}`);
        }
        break;
      case "status":
        if (typeof condition === "string") {
          if (person.status !== condition) return false;
        } else if (typeof condition?.not === "string") {
          if (person.status === condition.not) return false;
        } else {
          throw new Error(`unsupported status condition: ${JSON.stringify(condition)}`);
        }
        break;
      case "deletedAt":
        if (condition === null) {
          if (person.deletedAt !== null) return false;
        } else {
          throw new Error(`unsupported deletedAt condition: ${JSON.stringify(condition)}`);
        }
        break;
      case "managerId":
        if (person.managerId !== condition) return false;
        break;
      default:
        throw new Error(`the fake directory does not understand \`${key}\` — teach it or narrow the query`);
    }
  }
  return true;
}

vi.mock("../../src/config/prisma.js", () => {
  const noRows = () => vi.fn().mockResolvedValue([]);
  return {
    prisma: {
      user: {
        findMany: vi.fn(async (args: any) => {
          const rows = DIRECTORY.filter((p) => personMatches(p, args?.where));
          // `/team/reports` selects nested timesheets; everything else selects id+name. Returning
          // the superset is harmless and keeps one stand-in for both.
          return rows.map((p) => ({
            ...p,
            email: `${p.id}@example.test`,
            avatarUrl: null,
            bio: null,
            role: { name: "EMPLOYEE" },
            weeklyCapacityHours: 40,
            plannedUtilizationPct: 100,
            timesheets: state.timesheets.filter((t) => t.userId === p.id)
          }));
        }),
        findFirst: vi.fn(async (args: any) => DIRECTORY.find((p) => personMatches(p, args?.where)) ?? null),
        count: vi.fn(async (args: any) => DIRECTORY.filter((p) => personMatches(p, args?.where)).length)
      },
      globalTicketSettings: {
        findUnique: vi.fn(async () => ({
          id: "global",
          enableLeaderboard: state.leaderboardEnabled,
          enableCostAnalytics: false
        }))
      },
      ticket: {
        findMany: vi.fn(async () => state.tickets),
        // Generic single-column tally over the fake tickets. `by: ["status"]` has to work as well
        // as `by: ["assigneeId"]`, because the workspace total this suite guards is summed from
        // the status buckets — a stand-in that returned nothing there would make the most important
        // assertion in the file pass against a zero.
        groupBy: vi.fn(async (args: any) => {
          const column = args?.by?.[0];
          if (!column || args.by.length !== 1) return [];
          const counts = new Map<string, number>();
          for (const t of state.tickets) {
            const value = t[column] as string | null;
            if (!value) continue;
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return [...counts.entries()].map(([value, _count]) => ({ [column]: value, _count }));
        }),
        count: vi.fn(async () => state.tickets.length)
      },
      timesheet: {
        findMany: vi.fn(async () => state.timesheets),
        groupBy: vi.fn(async () => []),
        aggregate: vi.fn(async () => ({ _sum: { totalHours: 0 }, _count: 0 }))
      },
      auditLog: { findMany: noRows() },
      projectModule: { findMany: noRows() },
      project: { findMany: noRows() },
      securityFinding: { findMany: noRows(), groupBy: noRows(), count: vi.fn().mockResolvedValue(0) }
    }
  };
});

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: MANAGER, name: "The Manager" };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: vi.fn().mockResolvedValue({
    workingDays: [1, 2, 3, 4, 5],
    defaultWeeklyCapacityHours: 40
  })
}));

/** A ticket assigned to `assigneeId`, created and resolved inside the reporting window. */
function ticket(assigneeId: string, key: string) {
  const createdAt = new Date(Date.now() - 3 * 86_400_000);
  return {
    id: `ticket-${key}`,
    key,
    title: `Something for ${assigneeId}`,
    assigneeId,
    reporterId: assigneeId,
    status: "RESOLVED",
    priority: "MEDIUM",
    createdAt,
    resolvedAt: new Date(Date.now() - 86_400_000),
    dueAt: null,
    estimatedHours: null,
    moduleId: null,
    comments: []
  };
}

/** A timesheet row for `userId` inside the analytics window. */
function timesheetRow(userId: string, hours: number) {
  return {
    id: `ts-${userId}`,
    userId,
    workDate: new Date("2026-03-04T00:00:00.000Z"),
    totalHours: hours,
    billable: true,
    billedAmount: null,
    billedRate: null,
    activityType: "DEVELOPMENT",
    status: "APPROVED",
    submittedAt: new Date("2026-03-04T09:00:00.000Z"),
    reviewedAt: new Date("2026-03-04T17:00:00.000Z"),
    reviewedById: userId,
    approvalDeadline: null,
    slaBreachAt: null,
    deletedAt: null,
    user: { id: userId, name: "x", email: "x@example.test", hourlyRate: null },
    project: { id: "p1", name: "Apollo", code: "APL" },
    module: null,
    submodule: null,
    ticket: null
  };
}

describe("the rule itself", () => {
  it("hides a deactivated person and a soft-deleted one, and KEEPS an unverified invitee", async () => {
    const { NOT_DEACTIVATED } = await import("../../src/services/people-visibility.service.js");

    // Read as a predicate rather than compared as a literal: what matters is which people it
    // selects, not how it is spelled.
    for (const person of SHOWN) {
      expect(personMatches(person, NOT_DEACTIVATED as never), `${person.name} should still be shown`).toBe(true);
    }
    for (const person of HIDDEN) {
      expect(personMatches(person, NOT_DEACTIVATED as never), `${person.name} should be hidden`).toBe(false);
    }

    // The specific mistake this guards. `status: "ACTIVE"` selects the same two people to hide AND
    // hides the new joiner, so only naming them individually catches it.
    expect(personMatches(NEW_JOINER, NOT_DEACTIVATED as never)).toBe(true);
    expect(personMatches(NEW_JOINER, { status: "ACTIVE", deletedAt: null })).toBe(false);
  });

  it("resolves names for the shown, drops nullish ids, and asks nothing for an empty set", async () => {
    const { resolveVisiblePeopleNames } = await import("../../src/services/people-visibility.service.js");
    const { prisma } = await import("../../src/config/prisma.js");

    const names = await resolveVisiblePeopleNames([ASHA.id, DANA.id, RAVI.id, null, undefined, ASHA.id]);
    expect([...names.keys()]).toEqual([ASHA.id]);
    expect(names.get(ASHA.id)).toBe("Asha Rao");

    vi.mocked(prisma.user.findMany).mockClear();
    expect((await resolveVisiblePeopleNames([null, undefined])).size).toBe(0);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("counts what it dropped, so a screen can say so", async () => {
    const { withoutHiddenPeople } = await import("../../src/services/people-visibility.service.js");
    const visible = new Map([[ASHA.id, "Asha Rao"]]);
    const result = withoutHiddenPeople(
      [{ who: ASHA.id }, { who: DANA.id }, { who: RAVI.id }, { who: null }],
      (row) => row.who,
      visible
    );
    expect(result.rows).toEqual([{ who: ASHA.id }]);
    expect(result.hiddenInactive).toBe(3);
  });
});

describe("the screens", () => {
  let app: import("express").Express;
  let request: typeof import("supertest").default;

  // Booting these routers pulls in a large slice of the service layer. Paid once, in a hook with a
  // budget that reflects what it is, rather than against an `it`'s 10s allowance — see
  // security-finding-status-buckets.test.ts for the flake that taught us this.
  beforeAll(async () => {
    const express = (await import("express")).default;
    const { reportRouter } = await import("../../src/controllers/report.controller.js");
    const { teamRouter } = await import("../../src/controllers/team.controller.js");
    const { errorHandler } = await import("../../src/middleware/error.js");
    request = (await import("supertest")).default;

    app = express();
    app.use(express.json());
    app.use("/reports", reportRouter);
    app.use("/team", teamRouter);
    app.use(errorHandler);
  }, 60_000);

  beforeEach(() => {
    state.leaderboardEnabled = true;
    state.tickets = [
      ticket(ASHA.id, "HICS-1"),
      ticket(BEN.id, "HICS-2"),
      ticket(DANA.id, "HICS-3"),
      ticket(RAVI.id, "HICS-4")
    ];
    state.timesheets = [
      timesheetRow(ASHA.id, 8),
      timesheetRow(BEN.id, 6),
      timesheetRow(DANA.id, 7),
      timesheetRow(RAVI.id, 5)
    ];
  });

  /** Not async: supertest's return value is chainable (`.expect(...)`), and awaiting the import
   *  first would hand back a Promise instead. */
  function get(path: string) {
    return request(app).get(path);
  }

  it("leaderboard: ranks the shown, and says how many it left out", async () => {
    const res = await get("/reports/leaderboard").expect(200);
    const named = res.body.rows.map((r: { assigneeName: string }) => r.assigneeName);

    expect(named).toEqual(expect.arrayContaining(["Asha Rao", "Ben Cole"]));
    expect(named).not.toContain("Dana Fell");
    expect(named).not.toContain("Ravi Menon");
    // Never "Unknown": before this change a hard-deleted user fell through to that string, and a
    // hidden person taking the same path would have been indistinguishable from a data problem.
    expect(named).not.toContain("Unknown");
    expect(res.body.hiddenInactive).toBe(2);
  });

  it("ticket summary: drops the rows, KEEPS their tickets in the total", async () => {
    const res = await get("/reports/ticket-summary").expect(200);
    const named = res.body.byAssignee.map((r: { assignee: string }) => r.assignee);

    expect(named.sort()).toEqual(["Asha Rao", "Ben Cole"]);
    expect(res.body.hiddenInactiveAssignees).toBe(2);

    // The invariant that keeps this a display rule rather than a data rule. Four tickets exist;
    // two belong to people nobody is naming any more, and all four are still somebody's problem.
    expect(res.body.total).toBe(4);
  });

  it("workload heatmap: no hidden person holds a row", async () => {
    const res = await get("/reports/ticket-insights").expect(200);
    const named = res.body.workloadHeatmap.rows.map((r: { assigneeName: string }) => r.assigneeName);

    expect(named.sort()).toEqual(["Asha Rao", "Ben Cole"]);
    expect(res.body.workloadHeatmap.hiddenInactive).toBe(2);
  });

  it("utilisation: no row for a hidden person, but their hours stay in the totals", async () => {
    const res = await get("/reports/analytics?from=2026-03-01&to=2026-03-31").expect(200);

    const named = res.body.utilisation.map((r: { name: string }) => r.name);
    expect(named).not.toContain("Dana Fell");
    expect(named).not.toContain("Ravi Menon");
    expect(res.body.hiddenInactivePeople).toBe(2);

    // 8 + 6 + 7 + 5. A quarter's hours that silently lost the leavers is the failure this asserts
    // against — it would under-report utilisation-adjacent figures with nothing on screen to say so.
    expect(res.body.totals.hours).toBe(26);
    expect(res.body.totals.people).toBe(4);

    // The approver league table is per-person too, and follows the same rule; the latency figures
    // beside it are computed over every reviewed row, hidden reviewers included.
    //
    // Asserted on the ID, not the name. A leaked row carries `undefined` where the name should be —
    // so a check for the absence of "Dana Fell" passes while the row is sitting right there. That
    // is not hypothetical: removing the filter left this test green until it was written this way.
    const approverIds = res.body.approvalLatency.byApprover.map((a: { approverId: string }) => a.approverId);
    expect(approverIds.sort()).toEqual([ASHA.id, BEN.id]);
    expect(res.body.approvalLatency.byApprover.every((a: { name: string }) => Boolean(a.name))).toBe(true);
    expect(res.body.approvalLatency.hiddenInactiveApprovers).toBe(2);
    expect(res.body.approvalLatency.measured).toBe(4);
  });

  it("team page: the roster loses the deactivated and keeps the new joiner", async () => {
    const res = await get("/team/reports").expect(200);
    const named = res.body.map((r: { name: string }) => r.name);

    expect(named.sort()).toEqual(["Asha Rao", "Ben Cole", "Priya Nair"]);
  });

  it("hours trend: 404 for a hidden person even with the URL in hand", async () => {
    // The row is gone from the roster, so the dialog cannot be opened from the page. A kept link
    // would still have reached this endpoint, and a trend hidden everywhere except from whoever
    // bookmarked it is not hidden.
    await get(`/team/reports/${DANA.id}/hours-trend`).expect(404);
    await get(`/team/reports/${RAVI.id}/hours-trend`).expect(404);
    await get(`/team/reports/${ASHA.id}/hours-trend`).expect(200);
    await get(`/team/reports/${NEW_JOINER.id}/hours-trend`).expect(200);
  });
});

describe("the boundary — what must NOT change", () => {
  it("the export's row filter carries no notion of who is still employed", async () => {
    const { buildTimesheetWhere } = await import("../../src/services/timesheet-report.service.js");
    const where = buildTimesheetWhere({ from: "2026-03-01", to: "2026-03-31" } as never);

    // An export is a record of a period. Narrowing it by employment status would change what a
    // downloaded quarter MEANS, and would do it silently, to a file somebody is invoicing from.
    expect(where).not.toHaveProperty("user");
    expect(JSON.stringify(where)).not.toContain("INACTIVE");
    expect(JSON.stringify(where)).not.toContain("status");
  });

  it("the export still names a reviewer who has since been deactivated", async () => {
    const { resolveReviewerNames } = await import("../../src/services/timesheet-report.service.js");
    const names = await resolveReviewerNames([{ reviewedById: DANA.id }, { reviewedById: ASHA.id }]);

    // "Approved by Dana Fell" is a fact about a decision that was made. Blanking it because Dana
    // has since left would leave an approval with no approver on the audit copy of the record.
    expect(names.get(DANA.id)).toBe("Dana Fell");
    expect(names.get(ASHA.id)).toBe("Asha Rao");
  });
});
