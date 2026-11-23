/**
 * GET /agents/office-activity feeds the 3D office's replay. What must not regress:
 *   - it sits behind the same gates as the roster (auth, tickets:view, the AI-copilot plan gate);
 *   - it reads only through the tenant's Prisma client (no cross-tenant query shape);
 *   - a project the viewer cannot see is never named, summarised or used for a hand-off;
 *   - the response is capped;
 *   - hand-offs follow the documented, conservative rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = {
  id: "u-1",
  name: "Eve",
  email: "e@x.io",
  role: "EMPLOYEE",
  permissions: ["tickets:view"] as string[]
};

const profileFindMany = vi.fn();
const runFindMany = vi.fn();
const runGroupBy = vi.fn();
const projectFindMany = vi.fn();
const userFindMany = vi.fn().mockResolvedValue([]);
const assignmentFindMany = vi.fn();
const isPlanningCapabilityAllowed = vi.fn().mockResolvedValue(true);

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    }
  };
});
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    agentProfile: { findMany: profileFindMany },
    agentRun: { findMany: runFindMany, groupBy: runGroupBy },
    project: { findMany: projectFindMany },
    user: { findMany: userFindMany },
    userProjectAssignment: { findMany: assignmentFindMany }
  }
}));
vi.mock("../../src/config/tenant-context.js", () => ({
  requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" })
}));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: (...a: unknown[]) => isPlanningCapabilityAllowed(...a)
}));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn() }));

const { agentRouter } = await import("../../src/controllers/agent.controller.js");
const { deriveHandoffs, summaryLine, MAX_RUNS, HANDOFF_WINDOW_MS } = await import("../../src/services/agent-office-activity.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/agents", agentRouter);
  a.use(errorHandler);
  return a;
}

const NOW = Date.now();
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000);
const row = (o: Partial<Record<string, unknown>> & { id: string; onBehalfOfId: string }) => ({
  capability: "triage",
  status: "COMPLETED",
  flowId: null,
  scopeProjectId: null,
  goal: null,
  error: null,
  createdAt: at(30),
  startedAt: at(30),
  finishedAt: at(25),
  ...o
});

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "EMPLOYEE";
  actor.permissions = ["tickets:view"];
  isPlanningCapabilityAllowed.mockResolvedValue(true);
  profileFindMany.mockResolvedValue([
    { id: "agent-a", identityUserId: "id-a" },
    { id: "agent-b", identityUserId: "id-b" }
  ]);
  runGroupBy.mockResolvedValue([{ onBehalfOfId: "id-b", _count: { _all: 4 } }]);
  assignmentFindMany.mockResolvedValue([{ projectId: "p-seen" }]);
  projectFindMany.mockResolvedValue([{ id: "p-seen", code: "OPS", name: "Operations" }]);
  runFindMany.mockResolvedValue([]);
});

describe("GET /agents/office-activity — gates", () => {
  it("refuses a user without tickets:view", async () => {
    actor.permissions = [];
    const res = await request(app()).get("/agents/office-activity");
    expect(res.status).toBe(403);
    expect(runFindMany).not.toHaveBeenCalled();
  });

  it("refuses when the plan does not include the roster", async () => {
    isPlanningCapabilityAllowed.mockResolvedValue(false);
    const res = await request(app()).get("/agents/office-activity");
    expect(res.status).toBe(403);
    expect(runFindMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed or unknown query parameter", async () => {
    expect((await request(app()).get("/agents/office-activity?since=yesterday")).status).toBe(422);
    expect((await request(app()).get("/agents/office-activity?limit=9")).status).toBe(422);
  });

  it("only reads runs of this tenant's agent identities, within 24h or still pending", async () => {
    await request(app())
      .get(`/agents/office-activity?since=${encodeURIComponent(at(60 * 72).toISOString())}`)
      .expect(200);
    const where = runFindMany.mock.calls[0][0].where;
    expect(where.onBehalfOfId).toEqual({ in: ["id-a", "id-b"] });
    // A `since` older than 24h is clamped to 24h.
    const gte: Date = where.OR[0].createdAt.gte;
    expect(NOW - gte.getTime()).toBeLessThanOrEqual(24 * 3600_000 + 5_000);
    expect(runFindMany.mock.calls[0][0].take).toBe(MAX_RUNS + 1);
  });
});

describe("GET /agents/office-activity — visibility", () => {
  it("names a visible project but never a hidden one, and links only through visible ones", async () => {
    runFindMany.mockResolvedValue([
      row({
        id: "r4",
        onBehalfOfId: "id-b",
        status: "RUNNING",
        scopeProjectId: "p-hidden",
        goal: "Secret merger plan",
        createdAt: at(3),
        finishedAt: null
      }),
      row({
        id: "r3",
        onBehalfOfId: "id-a",
        scopeProjectId: "p-hidden",
        goal: "Secret",
        createdAt: at(8),
        finishedAt: at(5)
      }),
      row({
        id: "r2",
        onBehalfOfId: "id-b",
        status: "RUNNING",
        scopeProjectId: "p-seen",
        goal: "Plan the sprint\nmore",
        createdAt: at(10),
        finishedAt: null
      }),
      row({
        id: "r1",
        onBehalfOfId: "id-a",
        scopeProjectId: "p-seen",
        goal: "Sort <b>tickets</b>",
        createdAt: at(30),
        finishedAt: at(20)
      })
    ]);
    const res = await request(app()).get("/agents/office-activity").expect(200);
    const byId = new Map(res.body.events.map((e: { runId: string }) => [e.runId, e]));
    expect(byId.get("r2")).toMatchObject({
      entity: { type: "project", id: "p-seen", title: "OPS · Operations" },
      summary: "Plan the sprint"
    });
    expect(byId.get("r1")).toMatchObject({ summary: "Sort b tickets /b" });
    expect(byId.get("r4")).toMatchObject({
      entity: null,
      summary: null,
      status: "RUNNING"
    });
    expect(JSON.stringify(res.body)).not.toContain("p-hidden");
    expect(JSON.stringify(res.body)).not.toContain("Secret");
    // Only the hidden project's title lookup is skipped: the project query asks for visible ids only.
    expect(projectFindMany.mock.calls[0][0].where.id.in).toEqual(["p-seen"]);
    expect(res.body.handoffs).toEqual([
      expect.objectContaining({
        fromRunId: "r1",
        toRunId: "r2",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        kind: "project",
        title: "OPS · Operations"
      })
    ]);
    expect(res.body.queues).toEqual({ "agent-b": 4 });
  });

  it("a privileged viewer sees every project", async () => {
    actor.role = "ADMIN";
    runFindMany.mockResolvedValue([row({ id: "r1", onBehalfOfId: "id-a", scopeProjectId: "p-seen" })]);
    const res = await request(app()).get("/agents/office-activity").expect(200);
    expect(assignmentFindMany).not.toHaveBeenCalled();
    expect(res.body.events[0].entity.title).toBe("OPS · Operations");
  });

  it("caps the response and says so", async () => {
    runFindMany.mockResolvedValue(Array.from({ length: MAX_RUNS + 1 }, (_, i) => row({ id: `r${i}`, onBehalfOfId: "id-a" })));
    const res = await request(app()).get("/agents/office-activity").expect(200);
    expect(res.body.events).toHaveLength(MAX_RUNS);
    expect(res.body.truncated).toBe(true);
  });
});

describe("deriveHandoffs", () => {
  const base = { flowId: null, projectId: null, status: "COMPLETED" };
  const t0 = 1_000_000_000_000;

  it("prefers a shared flow over a shared project, and links each run at most once", () => {
    const links = deriveHandoffs([
      {
        ...base,
        id: "a1",
        agentId: "A",
        projectId: "p",
        createdAt: t0,
        finishedAt: t0 + 1000
      },
      {
        ...base,
        id: "c1",
        agentId: "C",
        flowId: "f",
        createdAt: t0,
        finishedAt: t0 + 500
      },
      {
        ...base,
        id: "b1",
        agentId: "B",
        projectId: "p",
        flowId: "f",
        status: "RUNNING",
        createdAt: t0 + 2000,
        finishedAt: null
      }
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      fromRunId: "c1",
      toRunId: "b1",
      kind: "flow"
    });
  });

  it("ignores the same agent, failed upstream runs, runs before A finished and gaps beyond the window", () => {
    const links = deriveHandoffs([
      {
        ...base,
        id: "a1",
        agentId: "A",
        projectId: "p",
        createdAt: t0,
        finishedAt: t0 + 1000
      },
      {
        ...base,
        id: "a2",
        agentId: "A",
        projectId: "p",
        createdAt: t0 + 2000,
        finishedAt: t0 + 3000
      },
      {
        ...base,
        id: "f1",
        agentId: "F",
        projectId: "q",
        status: "FAILED",
        createdAt: t0,
        finishedAt: t0 + 100
      },
      {
        ...base,
        id: "b1",
        agentId: "B",
        projectId: "q",
        createdAt: t0 + 200,
        finishedAt: null
      },
      {
        ...base,
        id: "b2",
        agentId: "B",
        projectId: "p",
        createdAt: t0 + 500,
        finishedAt: null
      },
      {
        ...base,
        id: "b3",
        agentId: "B",
        projectId: "p",
        createdAt: t0 + 3000 + HANDOFF_WINDOW_MS + 1,
        finishedAt: null
      }
    ]);
    expect(links).toEqual([]);
  });

  it("picks the most recent qualifying upstream run", () => {
    const links = deriveHandoffs(
      [
        {
          ...base,
          id: "a1",
          agentId: "A",
          projectId: "p",
          createdAt: t0,
          finishedAt: t0 + 1000
        },
        {
          ...base,
          id: "c1",
          agentId: "C",
          projectId: "p",
          createdAt: t0,
          finishedAt: t0 + 4000
        },
        {
          ...base,
          id: "b1",
          agentId: "B",
          projectId: "p",
          createdAt: t0 + 5000,
          finishedAt: null
        }
      ],
      () => "Title"
    );
    expect(links).toEqual([
      expect.objectContaining({
        fromRunId: "c1",
        toRunId: "b1",
        title: "Title"
      })
    ]);
  });
});

describe("summaryLine", () => {
  it("keeps one clean, short line", () => {
    expect(summaryLine(null)).toBeNull();
    expect(summaryLine("\n\n  hello\u0007   world \nsecond")).toBe("hello world");
    const long = summaryLine("x".repeat(500));
    expect(long?.length).toBeLessThanOrEqual(90);
    expect(long?.endsWith("…")).toBe(true);
  });
});
