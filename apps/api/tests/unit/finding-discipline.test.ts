/**
 * THE DISCIPLINE SPLIT, and the one regression this whole block exists to prevent.
 *
 * SonarQube and ESLint post into the same findings table, through the same webhook, as the security
 * scanners. A busy monorepo produces code smells by the thousand. If those count as findings, then
 * on the day somebody wires up a linter:
 *
 *   - the org risk score climbs by an order of magnitude and never comes down,
 *   - the by-severity chart fills with MEDIUMs and a single CRITICAL SQL injection becomes one bar
 *     in ten thousand,
 *   - the Monday security digest opens with a number nobody can act on,
 *   - and the per-ticket verdict says "Needs attention — 40 open HIGH findings" about a ticket with
 *     no security exposure at all.
 *
 * None of those is a crash. Every row is a real thing a real tool reported. The page keeps working
 * and quietly stops measuring security, which is the most expensive way a security metric can fail
 * and the hardest to notice. So the assertions here are deliberately blunt: a thousand code smells
 * must move the risk score by ZERO.
 *
 * `securityFindingTypeDisciplines` is the single answer, and this file is what stops it becoming
 * decorative — the map is checked for totality, and then the two consumers with the most at stake
 * are driven for real and asked what they counted.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  qualityDisciplineFindingTypes,
  securityDisciplineFindingTypes,
  securityFindingTypeDisciplines,
  securityFindingTypes
} from "@timesheet/shared";

describe("every finding type has a discipline", () => {
  it("covers the enum exactly, with nothing extra", () => {
    // TypeScript already enforces this on the Record. The assertion costs nothing and survives the
    // one `as` that would otherwise silence it.
    expect(Object.keys(securityFindingTypeDisciplines).sort()).toEqual([...securityFindingTypes].sort());
    for (const type of securityFindingTypes) {
      expect(["security", "quality"], `${type} has no discipline`).toContain(securityFindingTypeDisciplines[type]);
    }
  });

  it("partitions the enum — no type is in both derived lists, and none is in neither", () => {
    const all = [...securityDisciplineFindingTypes, ...qualityDisciplineFindingTypes];
    expect(all.sort()).toEqual([...securityFindingTypes].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("puts the scanner types on the security side and the code-quality types on the other", () => {
    for (const type of ["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as const) {
      expect(securityFindingTypeDisciplines[type], `${type} must count as security exposure`).toBe("security");
    }
    // Sonar's own VULNERABILITY maps to SAST at ingest precisely so that it lands on the line above
    // rather than here — see devops-ingest-sonar-eslint.test.ts.
    expect(securityFindingTypeDisciplines.QUALITY).toBe("quality");
    expect(securityFindingTypeDisciplines.LINT).toBe("quality");
  });
});

/**
 * The Security Insights aggregation, driven for real against an in-memory findings table that
 * honours the `type` and `status` filters the route sends. Recording the `where` clauses would
 * prove the filter was WRITTEN; returning rows through it proves the filter WORKS, which is the
 * question a risk score has to answer.
 */
const table = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key] ?? null;
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return value !== (c.not ?? null);
      if ("lt" in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
      if ("gte" in c) return value instanceof Date && value.getTime() >= (c.gte as Date).getTime();
      return false;
    }
    return value === (condition ?? null);
  });
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    securityFinding: {
      findMany: vi.fn().mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => table.rows.filter((r) => matchesWhere(r, where))),
      count: vi.fn().mockImplementation(async ({ where }: { where?: Record<string, unknown> } = {}) => table.rows.filter((r) => matchesWhere(r, where)).length),
      groupBy: vi.fn().mockImplementation(async ({ by, where }: { by: string[]; where?: Record<string, unknown> }) => {
        const hits = table.rows.filter((r) => matchesWhere(r, where));
        const counts = new Map<unknown, number>();
        for (const row of hits) counts.set(row[by[0]] ?? null, (counts.get(row[by[0]] ?? null) ?? 0) + 1);
        return [...counts].map(([value, count]) => ({ [by[0]]: value, _count: count }));
      })
    },
    projectModule: { findMany: vi.fn().mockResolvedValue([]) }
  }
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

function finding(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    type: "SAST",
    severity: "CRITICAL",
    status: "OPEN",
    repository: null,
    moduleId: null,
    verificationState: null,
    createdAt: now,
    updatedAt: now,
    firstSeenAt: now,
    verifiedFixedAt: null,
    ...over
  };
}

/**
 * The app, built ONCE in a hook with its own budget.
 *
 * `report.controller.ts` pulls in a large slice of the service layer, and the mocks above mean it
 * can only be loaded dynamically, after they are registered. When that import sat inside this
 * helper, the FIRST test to call it paid the whole cost against the 10s test budget — and under a
 * full parallel suite on a loaded machine it intermittently exceeded it. The suite then failed on
 * the single most important assertion in this file and passed on a re-run, which is the kind of
 * red that teaches people to press the button again instead of reading it.
 *
 * Nothing hangs; it is module loading. So it is paid once, in a hook, with a budget that says what
 * it actually is.
 */
let app: import("express").Express;

beforeAll(async () => {
  const express = (await import("express")).default;
  const { reportRouter } = await import("../../src/controllers/report.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");

  app = express();
  app.use(express.json());
  app.use("/reports", reportRouter);
  app.use(errorHandler);
}, 60_000);

async function securityInsights() {
  const request = (await import("supertest")).default;
  const res = await request(app).get("/reports/security-insights").expect(200);
  return res.body;
}

describe("a thousand code smells and the org risk score", () => {
  it("does not move it — not by one point", async () => {
    // One genuine open CRITICAL, and nothing else.
    table.rows = [finding()];
    const before = await securityInsights();
    expect(before.totalOpen).toBe(1);
    expect(before.riskScore).toBeGreaterThan(0);

    // Now the linter gets wired into CI.
    table.rows = [
      finding(),
      ...Array.from({ length: 700 }, () => finding({ type: "QUALITY", severity: "MEDIUM" })),
      ...Array.from({ length: 300 }, () => finding({ type: "LINT", severity: "LOW" }))
    ];
    const after = await securityInsights();

    // THE ASSERTION THIS ENTIRE BLOCK EXISTS FOR.
    expect(after.riskScore).toBe(before.riskScore);
    expect(after.totalOpen).toBe(1);
    expect(after.openBySeverity).toEqual(before.openBySeverity);
    expect(after.byType).toEqual(before.byType);
  });

  it("reports them, in their own section, rather than hiding them", async () => {
    // The other half of the promise. Filtering them out of the security numbers is only defensible
    // because they are still counted somewhere a person can see.
    table.rows = [
      finding(),
      ...Array.from({ length: 700 }, () => finding({ type: "QUALITY", severity: "MEDIUM" })),
      ...Array.from({ length: 300 }, () => finding({ type: "LINT", severity: "LOW" }))
    ];
    const body = await securityInsights();

    expect(body.quality.totalOpen).toBe(1000);
    expect(body.quality.openBySeverity).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 700, LOW: 300 });
    expect(body.quality.byType).toEqual([
      { type: "QUALITY", count: 700 },
      { type: "LINT", count: 300 }
    ]);
  });

  it("keeps the by-type chart to the security types, so a quality bar cannot appear on it", async () => {
    table.rows = [finding(), finding({ type: "QUALITY", severity: "HIGH" })];
    const body = await securityInsights();
    expect(body.byType.map((row: { type: string }) => row.type)).toEqual([...securityDisciplineFindingTypes]);
  });

  it("counts a Sonar VULNERABILITY, because it arrives as SAST", async () => {
    // The other direction of the same rule. A workspace running Sonar and nothing else must still
    // see its injection risks in the risk score — otherwise this split would have quietly turned
    // one integration into no security coverage at all.
    table.rows = [finding({ type: "SAST", severity: "CRITICAL" })];
    const body = await securityInsights();
    expect(body.totalOpen).toBe(1);
    expect(body.riskScore).toBeGreaterThan(0);
  });
});
