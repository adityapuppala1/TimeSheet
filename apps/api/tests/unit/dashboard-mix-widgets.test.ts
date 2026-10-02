/**
 * The two breakdown widgets added to the closed catalogue. What matters is that they define
 * "open" the way STATUS_MIX does (same where clause, so the three tiles agree), honour the
 * viewer's project scope, and read in a stable order — a tile that reshuffles as numbers move is
 * harder to read week over week.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const groupBy = vi.fn();
const findMany = vi.fn();
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticket: { groupBy: (...a: unknown[]) => groupBy(...a) },
    project: { findMany: (...a: unknown[]) => findMany(...a) }
  }
}));

const { resolveWidget, WIDGET_CATALOGUE, WIDGET_TYPES } = await import("../../src/services/dashboard.service.js");

beforeEach(() => {
  groupBy.mockReset();
  findMany.mockReset();
});

const params = (type: "PRIORITY_MIX" | "PROJECT_MIX") => ({ type, config: {}, projectIds: ["p1", "p2"], viewerId: "u1" });

describe("catalogue", () => {
  it("lists both as BREAKDOWN widgets, so the existing renderer draws them with no web change", () => {
    for (const type of ["PRIORITY_MIX", "PROJECT_MIX"] as const) {
      expect(WIDGET_TYPES).toContain(type);
      expect(WIDGET_CATALOGUE.find((w) => w.type === type)?.shape).toBe("BREAKDOWN");
    }
  });
});

describe("PRIORITY_MIX", () => {
  it("counts open work in the viewer's scope and reads in severity order regardless of counts", async () => {
    groupBy.mockResolvedValue([
      { priority: "LOW", _count: { _all: 40 } },
      { priority: "CRITICAL", _count: { _all: 2 } },
      { priority: "HIGH", _count: { _all: 7 } }
    ]);
    const w = await resolveWidget(params("PRIORITY_MIX") as never);
    expect(groupBy.mock.calls[0][0]).toMatchObject({
      by: ["priority"],
      // Open = not resolved and not closed (workspace-metrics.ts), the same as OPEN_ITEMS.
      where: { projectId: { in: ["p1", "p2"] }, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } }
    });
    expect((w as any).points).toEqual([
      { label: "critical", value: 2 },
      { label: "high", value: 7 },
      { label: "low", value: 40 }
    ]);
  });

  it("narrows to one project when the widget is configured with one", async () => {
    groupBy.mockResolvedValue([]);
    await resolveWidget({ ...params("PRIORITY_MIX"), config: { projectId: "p2" } } as never);
    expect(groupBy.mock.calls[0][0].where.projectId).toEqual({ in: ["p2"] });
  });
});

describe("PROJECT_MIX", () => {
  it("names projects and sorts the busiest first", async () => {
    groupBy.mockResolvedValue([
      { projectId: "p1", _count: { _all: 3 } },
      { projectId: "p2", _count: { _all: 9 } }
    ]);
    findMany.mockResolvedValue([{ id: "p1", name: "Web" }, { id: "p2", name: "ERP" }]);
    const w = await resolveWidget(params("PROJECT_MIX") as never);
    expect((w as any).points).toEqual([
      { label: "ERP", value: 9 },
      { label: "Web", value: 3 }
    ]);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["p1", "p2"] } } });
  });

  it("is empty, not broken, when nothing is open", async () => {
    groupBy.mockResolvedValue([]);
    findMany.mockResolvedValue([]);
    const w = await resolveWidget(params("PROJECT_MIX") as never);
    expect((w as any).points).toEqual([]);
  });
});
