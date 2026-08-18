/**
 * The per-agent daily spend ceiling, and the switched-off check beside it.
 *
 * WHY THIS FILE EXISTS: the roster page displays `maxCostUsdPerDay` next to a progress bar, and a
 * ceiling a product SHOWS but does not APPLY is worse than no ceiling — it is read as a guarantee.
 * It was stored and rendered a commit before it was enforced, which is exactly the state this test
 * makes impossible to return to.
 *
 * Both checks live in `queueAgentRun`'s preflight rather than at execution, for the reason the
 * existing run-count check states: refusing to queue is the only refusal that costs nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runFindUnique = vi.fn().mockResolvedValue(null);
const runCount = vi.fn().mockResolvedValue(0);
const runAggregate = vi.fn().mockResolvedValue({ _sum: { costUsd: null } });
const runCreate = vi.fn();
const profileFindFirst = vi.fn().mockResolvedValue(null);
const loadRequestUser = vi.fn();
const resolveAutonomy = vi.fn();

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    agentRun: { findUnique: runFindUnique, count: runCount, aggregate: runAggregate, create: runCreate },
    agentProfile: { findFirst: profileFindFirst }
  }
}));
vi.mock("../../src/services/principal.service.js", () => ({ loadRequestUser: (...a: unknown[]) => loadRequestUser(...a) }));
vi.mock("../../src/services/ai-autonomy.service.js", () => ({ resolveAutonomy: (...a: unknown[]) => resolveAutonomy(...a) }));

const { queueAgentRun } = await import("../../src/services/agent-run.service.js");

const AGENT = { id: "agent-user-1", name: "Reporter", email: "reporter@agents.invalid", role: "EMPLOYEE", permissions: [], isAgent: true };
const HUMAN = { id: "u-1", name: "Avery", email: "a@x.io", role: "SUPER_ADMIN", permissions: [], isAgent: false };

const queue = (onBehalfOfId: string) =>
  queueAgentRun({
    capability: "weekly_digest",
    trigger: "manual",
    triggerKey: `k-${Math.random().toString(36).slice(2)}`,
    onBehalfOfId
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  runFindUnique.mockResolvedValue(null);
  runCount.mockResolvedValue(0);
  runAggregate.mockResolvedValue({ _sum: { costUsd: null } });
  runCreate.mockResolvedValue({ id: "run-1" });
  profileFindFirst.mockResolvedValue(null);
  loadRequestUser.mockResolvedValue(AGENT);
  resolveAutonomy.mockResolvedValue({
    capability: "weekly_digest",
    requestedLevel: "AUTONOMOUS",
    effectiveLevel: "AUTONOMOUS",
    maxLevel: "AUTONOMOUS",
    clampedReason: null,
    guardrails: { maxChangesPerRun: null, maxRunsPerDay: null, maxCostUsdPerRun: null, undoWindowHours: null, scopeProjectIds: [] }
  });
});

describe("the per-agent daily ceiling", () => {
  it("refuses to queue once the day's spend has reached it, naming both figures", async () => {
    profileFindFirst.mockResolvedValue({ name: "Reporter", enabled: true, maxCostUsdPerDay: 2 });
    runAggregate.mockResolvedValue({ _sum: { costUsd: 2.5 } });

    await expect(queue(AGENT.id)).rejects.toMatchObject({ statusCode: 429 });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("allows a run while there is room left", async () => {
    profileFindFirst.mockResolvedValue({ name: "Reporter", enabled: true, maxCostUsdPerDay: 2 });
    runAggregate.mockResolvedValue({ _sum: { costUsd: 0.9 } });

    await expect(queue(AGENT.id)).resolves.toMatchObject({ created: true });
  });

  it("sums only TODAY's runs, so yesterday's spend cannot exhaust today", async () => {
    profileFindFirst.mockResolvedValue({ name: "Reporter", enabled: true, maxCostUsdPerDay: 5 });
    await queue(AGENT.id);
    const where = runAggregate.mock.calls[0][0].where;
    expect(where.onBehalfOfId).toBe(AGENT.id);
    const since = where.createdAt.gte as Date;
    expect(since.getHours()).toBe(0);
    expect(since.getMinutes()).toBe(0);
  });

  it("does not apply a ceiling that is null — null means 'no profile cap', never 'unlimited elsewhere'", async () => {
    profileFindFirst.mockResolvedValue({ name: "Reporter", enabled: true, maxCostUsdPerDay: null });
    await expect(queue(AGENT.id)).resolves.toMatchObject({ created: true });
    expect(runAggregate).not.toHaveBeenCalled();
  });

  it("leaves an ordinary person's run alone — no profile lookup at all", async () => {
    loadRequestUser.mockResolvedValue(HUMAN);
    await expect(queue(HUMAN.id)).resolves.toMatchObject({ created: true });
    expect(profileFindFirst).not.toHaveBeenCalled();
  });
});

describe("a switched-off agent does not run", () => {
  it("refuses to queue for a disabled profile", async () => {
    // "Off" has to mean off at the point work is created, not merely be a badge on a card.
    profileFindFirst.mockResolvedValue({ name: "Reporter", enabled: false, maxCostUsdPerDay: null });
    await expect(queue(AGENT.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("still allows a run for an agent identity with no profile row, rather than dead-ending it", async () => {
    // A retired profile leaves its identity behind on purpose (audit rows point at it). Refusing
    // here would turn tidying the roster into a way to break a scheduled capability.
    profileFindFirst.mockResolvedValue(null);
    await expect(queue(AGENT.id)).resolves.toMatchObject({ created: true });
  });
});

describe("the idempotency key still wins", () => {
  it("returns the existing run without spending any allowance", async () => {
    runFindUnique.mockResolvedValue({ id: "already-there" });
    profileFindFirst.mockResolvedValue({ name: "Reporter", enabled: true, maxCostUsdPerDay: 0.01 });
    runAggregate.mockResolvedValue({ _sum: { costUsd: 99 } });

    // Re-queueing something that already exists is not a new run: it must not be refused by a
    // ceiling, and must not consume one either.
    await expect(queue(AGENT.id)).resolves.toEqual({ runId: "already-there", created: false });
    expect(runAggregate).not.toHaveBeenCalled();
  });
});
