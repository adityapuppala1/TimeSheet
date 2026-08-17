/**
 * The roster is PACKAGING, and this file exists to keep it that way.
 *
 * The failure this guards against is the one that turns a convenience into a second permission
 * system: a profile that appears to grant a level, or that is created already switched on, or that
 * names a capability which does not exist and therefore silently does nothing. Each of those looks
 * harmless in a diff and is discovered later by someone asking why an agent did more — or less —
 * than the roster said it would.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "admin-1", name: "Avery", email: "a@x.io", role: "SUPER_ADMIN", permissions: ["tickets:view"] as string[] };

const profileCreate = vi.fn();
const profileFindMany = vi.fn().mockResolvedValue([]);
const profileFindFirst = vi.fn();
const userCreate = vi.fn();
const userFindMany = vi.fn().mockResolvedValue([]);
const roleFindUniqueOrThrow = vi.fn().mockResolvedValue({ id: "role-emp", name: "EMPLOYEE" });
const runCount = vi.fn().mockResolvedValue(0);
const runFindMany = vi.fn().mockResolvedValue([]);
const runAggregate = vi.fn().mockResolvedValue({ _sum: { costUsd: null } });
const isPlanningCapabilityAllowed = vi.fn().mockResolvedValue(true);
const resolveAutonomy = vi.fn();

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
    agentProfile: { create: profileCreate, findMany: profileFindMany, findFirst: profileFindFirst, update: vi.fn() },
    user: { create: userCreate, findMany: userFindMany, update: vi.fn() },
    role: { findUniqueOrThrow: roleFindUniqueOrThrow },
    agentRun: { count: runCount, findMany: runFindMany, aggregate: runAggregate },
    $transaction: vi.fn()
  }
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: (...a: unknown[]) => isPlanningCapabilityAllowed(...a)
}));
vi.mock("../../src/services/ai-autonomy.service.js", () => ({ resolveAutonomy: (...a: unknown[]) => resolveAutonomy(...a) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { agentRouter } = await import("../../src/controllers/agent.controller.js");
const { AGENT_TEMPLATES, validateCapabilities } = await import("../../src/services/agent-profile.service.js");
const { findCapability } = await import("../../src/services/ai-capability.registry.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/agents", agentRouter);
  a.use(errorHandler);
  return a;
}

const identityRow = { id: "agent-user-1", name: "Triage", email: "triage@agents.invalid" };

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "SUPER_ADMIN";
  actor.permissions = ["tickets:view"];
  isPlanningCapabilityAllowed.mockResolvedValue(true);
  profileFindMany.mockResolvedValue([]);
  profileFindFirst.mockResolvedValue(null);
  userCreate.mockResolvedValue(identityRow);
  userFindMany.mockResolvedValue([]);
  runCount.mockResolvedValue(0);
  runFindMany.mockResolvedValue([]);
  runAggregate.mockResolvedValue({ _sum: { costUsd: null } });
  resolveAutonomy.mockImplementation((id: string) =>
    Promise.resolve({
      capability: id,
      requestedLevel: "SUGGEST",
      effectiveLevel: "SUGGEST",
      maxLevel: "AUTO_APPLY",
      clampedReason: null,
      guardrails: {}
    })
  );
  profileCreate.mockImplementation(({ data }: any) =>
    Promise.resolve({
      id: "p-1",
      name: data.name,
      emoji: data.emoji,
      description: data.description,
      identityUserId: identityRow.id,
      identityUser: identityRow,
      capabilities: data.capabilities,
      scopeProjectIds: data.scopeProjectIds,
      maxCostUsdPerDay: data.maxCostUsdPerDay,
      enabled: data.enabled,
      templateKey: data.templateKey,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null
    })
  );
});

describe("the built-in gallery", () => {
  it("names only capabilities that exist in the registry", () => {
    // A template naming a capability the registry does not have would install a teammate that
    // silently does nothing — the roster would show it, and no run would ever match.
    for (const template of AGENT_TEMPLATES) {
      for (const id of template.capabilities) {
        expect(findCapability(id), `${template.key} → ${id}`).toBeDefined();
      }
    }
  });

  it("has a unique key per template, since the key is what 'already installed' is judged on", () => {
    const keys = AGENT_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("capability validation refuses rather than drops", () => {
  it("rejects an unknown capability by name", () => {
    expect(() => validateCapabilities(["triage", "make_me_a_sandwich"])).toThrowError(/make_me_a_sandwich/);
  });

  it("rejects an empty bundle", () => {
    expect(() => validateCapabilities([])).toThrowError(/at least one/i);
  });

  it("de-duplicates rather than storing the same capability twice", () => {
    expect(validateCapabilities(["triage", "triage"])).toEqual(["triage"]);
  });
});

describe("a profile grants nothing", () => {
  it("is created DISABLED even when the caller is a super admin", async () => {
    // An agent that arrives switched on is the failure the MCP write latches were designed against.
    const res = await request(app()).post("/agents").send({ name: "Triage", capabilities: ["triage"] });
    expect(res.status).toBe(201);
    expect(profileCreate.mock.calls[0][0].data.enabled).toBe(false);
    expect(res.body.enabled).toBe(false);
  });

  it("reports the RESOLVED autonomy per capability, not the product ceiling", async () => {
    // The roster must not advertise authority a run would not actually get: the number shown comes
    // from the same resolveAutonomy every caller reads, clamps included.
    resolveAutonomy.mockResolvedValue({
      capability: "triage",
      requestedLevel: "AUTO_APPLY",
      effectiveLevel: "SUGGEST",
      maxLevel: "AUTO_APPLY",
      clampedReason: "AI features are switched off for this workspace.",
      guardrails: {}
    });
    const res = await request(app()).post("/agents").send({ name: "Triage", capabilities: ["triage"] });
    expect(res.body.capabilities[0].autonomy.effectiveLevel).toBe("SUGGEST");
    expect(res.body.capabilities[0].autonomy.clampedReason).toMatch(/switched off/i);
  });

  it("mints an identity on the reserved mail domain", async () => {
    await request(app()).post("/agents").send({ name: "Triage", capabilities: ["triage"] });
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isAgent: true, status: "ACTIVE" }) })
    );
    expect(userCreate.mock.calls[0][0].data.email).toMatch(/@agents\.invalid$/);
    // EMPLOYEE, because an agent's authority comes from AiCapabilityPolicy and never from a role.
    expect(roleFindUniqueOrThrow).toHaveBeenCalledWith({ where: { name: "EMPLOYEE" } });
  });
});

describe("installing from the gallery", () => {
  it("takes the capability bundle from the catalogue, not from the request", async () => {
    // Otherwise "this is the stock triage teammate, unmodified" becomes a claim a client can assert
    // about any bundle it likes.
    const res = await request(app()).post("/agents/install").send({ templateKey: "triage", capabilities: ["schedule_adjustment"] });
    expect(res.status).toBe(422); // .strict() — the extra field is refused outright
    expect(profileCreate).not.toHaveBeenCalled();
  });

  it("installs a known template and stores its key", async () => {
    const res = await request(app()).post("/agents/install").send({ templateKey: "triage" });
    expect(res.status).toBe(201);
    const data = profileCreate.mock.calls[0][0].data;
    expect(data.templateKey).toBe("triage");
    expect(data.capabilities).toEqual(AGENT_TEMPLATES.find((t) => t.key === "triage")!.capabilities);
  });

  it("404s an unknown template rather than inventing one", async () => {
    const res = await request(app()).post("/agents/install").send({ templateKey: "does-not-exist" });
    expect(res.status).toBe(404);
  });

  it("409s a second copy of the same template", async () => {
    profileFindFirst.mockResolvedValue({ id: "already" });
    const res = await request(app()).post("/agents/install").send({ templateKey: "triage" });
    expect(res.status).toBe(409);
    expect(profileCreate).not.toHaveBeenCalled();
  });
});

describe("the gates", () => {
  it("fails closed without the AI copilot entitlement, and says upgrade", async () => {
    isPlanningCapabilityAllowed.mockResolvedValue(false);
    const res = await request(app()).get("/agents");
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not included in this plan/i);
    expect(profileFindMany).not.toHaveBeenCalled();
  });

  it("asks about aiPmCopilotEnabled specifically", async () => {
    await request(app()).get("/agents");
    expect(isPlanningCapabilityAllowed).toHaveBeenCalledWith("org-1", "aiPmCopilotEnabled");
  });

  it("lets a non-admin with tickets:view READ the roster", async () => {
    // Anybody working alongside a teammate may ask what it is and what it has been doing.
    actor.role = "EMPLOYEE";
    const res = await request(app()).get("/agents");
    expect(res.status).toBe(200);
  });

  it("refuses creation by a non-super-admin", async () => {
    actor.role = "MANAGER";
    const res = await request(app()).post("/agents").send({ name: "Rogue", capabilities: ["triage"] });
    expect(res.status).toBe(403);
    expect(profileCreate).not.toHaveBeenCalled();
  });
});
