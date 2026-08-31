/**
 * Ingestion used to be an unconditional INSERT. A nightly scan reporting the same 200 issues wrote
 * 200 new rows every night, so a workspace that changed nothing watched its risk score climb, its
 * insights trend slope upwards forever, its weekly digest count one vulnerability seven times, and
 * — worst of the four — a fresh ticket open for the same line of code every morning.
 *
 * This file drives the REAL router against an in-memory stand-in for the two Prisma models it
 * writes, rather than asserting on mock call counts: dedup is a statement about what ends up in
 * the table, and a test that only checks which methods were called cannot tell a correct upsert
 * from a create that happened to be named one.
 *
 * That same method is why the finding-ROUTING assertions live here too (see "where the finding says
 * it belongs" below). Which module a finding is attributed to is another statement about what ends
 * up in the row, and this harness already puts a real request through the real router. The
 * resolution itself — first-match-wins, ordering, fallbacks — is proved without a router in
 * finding-routing.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface FindingRow {
  id: string;
  ticketId: string | null;
  fingerprint: string | null;
  repository: string | null;
  branch: string | null;
  scanRunId: string | null;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  aiTriagedAt: Date | null;
  [key: string]: unknown;
}

interface ScanRunRow {
  id: string;
  tool: string;
  type: string;
  repository: string | null;
  branch: string | null;
  commitSha: string | null;
  findingCount: number;
}

const findings: FindingRow[] = [];
const scanRuns: ScanRunRow[] = [];
/** Finding-routing rules. Empty for every test except the routing block at the foot of this file —
 *  which is also the assertion that an unconfigured workspace ingests unchanged. */
const repositoryMaps: Array<Record<string, unknown>> = [];
const modulePathRules: Array<Record<string, unknown>> = [];
let seq = 0;

/** Matches Prisma's `findFirst` semantics for the three columns the ingest looks up on, including
 *  the one that matters most: `null` means "IS NULL", not "any value". A stand-in that treated a
 *  null repository as a wildcard would make this whole file pass while the real query did not. */
function matches(row: FindingRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => (row[key] ?? null) === (value ?? null));
}

vi.mock("../../src/config/prisma.js", () => ({
  getTenantClient: vi.fn().mockResolvedValue({}),
  prisma: {
    ingestionSettings: { findUnique: vi.fn().mockResolvedValue({ encryptedToken: "token" }) },
    ticket: { findFirst: vi.fn().mockResolvedValue(null) },
    // The finding-routing rules, read once per batch (see services/finding-routing.service.ts).
    // Mutable arrays rather than fixed empties so the routing block at the foot of this file can
    // put a rule in front of the ingest — and so the DEFAULT for every other test here is a
    // workspace with nothing configured, which must ingest exactly as it always did.
    repositoryMap: { findMany: vi.fn().mockImplementation(async () => repositoryMaps) },
    modulePathRule: { findMany: vi.fn().mockImplementation(async () => modulePathRules) },
    scanRun: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = { id: `run-${seq}`, ...data } as ScanRunRow;
        scanRuns.push(row);
        return row;
      })
    },
    securityFinding: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const now = new Date();
        const row: FindingRow = {
          id: `finding-${seq}`,
          ticketId: null,
          fingerprint: null,
          repository: null,
          branch: null,
          scanRunId: null,
          occurrences: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          aiTriagedAt: null,
          ...data
        };
        findings.push(row);
        return row;
      }),
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        return findings.find((row) => matches(row, where)) ?? null;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = findings.find((f) => f.id === where.id)!;
        for (const [key, value] of Object.entries(data)) {
          // Prisma's `{ increment: n }` write, which the occurrence counter depends on.
          if (value && typeof value === "object" && "increment" in (value as Record<string, unknown>)) {
            row[key] = (row[key] as number) + ((value as { increment: number }).increment ?? 0);
          } else {
            row[key] = value;
          }
        }
        return row;
      })
    }
  }
}));
vi.mock("../../src/middleware/tenant.js", () => ({
  resolveActiveOrgBySlug: vi.fn().mockResolvedValue({ id: "org-1", slug: "acme", database: { encryptedDsn: "dsn" } })
}));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (value: string) => value }));
vi.mock("../../src/utils/security.js", () => ({ constantTimeEqual: () => true }));

const maybeAutoCreateTicketForFinding = vi.fn().mockResolvedValue(undefined);
const verifyFindingsAgainstScanRun = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/security-report.service.js", () => ({
  maybeAssignFindingViaCodeowners: vi.fn().mockResolvedValue(undefined),
  maybeAutoCreateTicketForCiFailure: vi.fn().mockResolvedValue(undefined),
  maybeAutoCreateTicketForFinding,
  maybePostCiFailureTriageComment: vi.fn().mockResolvedValue(undefined),
  maybeReopenTicketOnRegression: vi.fn().mockResolvedValue(undefined),
  maybeTriageFindingWithAI: vi.fn().mockResolvedValue(undefined),
  // The verification verdict fires once per recorded ScanRun. Stubbed here — this file is about
  // what dedup puts in the table; what the verdict then decides is finding-verification.test.ts.
  verifyFindingsAgainstScanRun
}));

const { devopsWebhookRouter } = await import("../../src/controllers/devops-webhook.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/devops", devopsWebhookRouter);
  a.use(errorHandler);
  return a;
}

/** One identifiable finding: a tool, a CWE, a file and a line is everything the fingerprint needs. */
function identifiableFinding(overrides: Record<string, unknown> = {}) {
  return {
    type: "SAST",
    tool: "semgrep",
    severity: "CRITICAL",
    title: "SQL injection",
    cwe: "CWE-89",
    filePath: "src/db/query.ts",
    lineNumber: 120,
    repository: "acme/api",
    branch: "main",
    ...overrides
  };
}

function post(body: Record<string, unknown>) {
  return request(app()).post("/devops/acme/findings").set("Authorization", "Bearer token").send(body).expect(201);
}

beforeEach(() => {
  findings.length = 0;
  scanRuns.length = 0;
  repositoryMaps.length = 0;
  modulePathRules.length = 0;
  seq = 0;
  maybeAutoCreateTicketForFinding.mockClear();
  verifyFindingsAgainstScanRun.mockClear();
});

describe("the same finding, reported by two scans", () => {
  it("produces one row, with the occurrence count raised and the sighting moved forward", async () => {
    const first = await post({ findings: [identifiableFinding()] });
    expect(first.body).toEqual({ ingested: 1, created: 1, updated: 0 });
    expect(findings).toHaveLength(1);

    const firstSeen = findings[0].firstSeenAt;
    const initialLastSeen = findings[0].lastSeenAt;

    const second = await post({ findings: [identifiableFinding()] });
    expect(second.body).toEqual({ ingested: 1, created: 0, updated: 1 });

    // THE ASSERTION THIS WHOLE FEATURE EXISTS FOR: still one row.
    expect(findings).toHaveLength(1);
    expect(findings[0].occurrences).toBe(2);
    expect(findings[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(initialLastSeen.getTime());
    // `firstSeenAt` is the one timestamp a re-sighting must never move — it is what "how long has
    // this been open" is measured from, and the risk score's age decay reads it.
    expect(findings[0].firstSeenAt).toBe(firstSeen);
  });

  it("does not open a second ticket for it", async () => {
    // The duplicate-ticket-every-morning bug, asserted directly.
    await post({ findings: [identifiableFinding()] });
    expect(maybeAutoCreateTicketForFinding).toHaveBeenCalledTimes(1);
    await post({ findings: [identifiableFinding()] });
    expect(maybeAutoCreateTicketForFinding).toHaveBeenCalledTimes(1);
  });

  it("does not reopen or otherwise touch its status", async () => {
    await post({ findings: [identifiableFinding()] });
    findings[0].status = "FIXED";
    await post({ findings: [identifiableFinding()] });
    // Re-reporting something is not a reason to reopen it. What a still-present "fixed" finding
    // means is the verification work's decision, and it is deliberately not made here.
    expect(findings[0].status).toBe("FIXED");
  });

  it("still deduplicates across a small line drift", async () => {
    await post({ findings: [identifiableFinding()] });
    await post({ findings: [identifiableFinding({ lineNumber: 112 })] });
    expect(findings).toHaveLength(1);
    expect(findings[0].occurrences).toBe(2);
  });
});

describe("findings that are genuinely different", () => {
  it("each get their own row", async () => {
    const res = await post({
      findings: [identifiableFinding(), identifiableFinding({ filePath: "src/db/other.ts" }), identifiableFinding({ cwe: "CWE-79" })]
    });
    expect(res.body).toEqual({ ingested: 3, created: 3, updated: 0 });
    expect(findings).toHaveLength(3);
  });

  it("are kept apart by branch, because the same code can be fixed on one and not the other", async () => {
    await post({ findings: [identifiableFinding()] });
    await post({ findings: [identifiableFinding({ branch: "release/2.0" })] });
    expect(findings).toHaveLength(2);
  });
});

describe("a finding with nothing to identify it", () => {
  it("is still ingested, every time, rather than dropped", async () => {
    // No file path and no CWE: no fingerprint can be derived. The old create-always behaviour is
    // the fallback on purpose — losing a real vulnerability because we could not name it is far
    // worse than storing it twice.
    const payload = { type: "SAST", tool: "gitleaks", severity: "HIGH", title: "Secret detected" };
    await post({ findings: [payload] });
    await post({ findings: [payload] });
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.fingerprint === null)).toBe(true);
  });
});

describe("the scan run", () => {
  it("is recorded for every ingest, with what it scanned and how much it found", async () => {
    await post({
      findings: [identifiableFinding(), identifiableFinding({ filePath: "src/db/other.ts" })],
      commitSha: "abc123"
    });

    expect(scanRuns).toHaveLength(1);
    expect(scanRuns[0]).toMatchObject({
      tool: "semgrep",
      type: "SAST",
      repository: "acme/api",
      branch: "main",
      commitSha: "abc123",
      findingCount: 2
    });
  });

  it("links every finding it reported, including the ones that deduplicated", async () => {
    await post({ findings: [identifiableFinding()] });
    const firstRunId = scanRuns[0].id;
    expect(findings[0].scanRunId).toBe(firstRunId);

    await post({ findings: [identifiableFinding()] });
    const secondRunId = scanRuns[1].id;
    // The link points at the LATEST run that reported it. That is what makes "which findings did
    // tonight's run contain?" answerable, which is the question the verification work is built on.
    expect(secondRunId).not.toBe(firstRunId);
    expect(findings[0].scanRunId).toBe(secondRunId);
  });

  it("splits one request into one run per tool, so a run means one scanner's scan", async () => {
    // A CI job may well post semgrep's and gitleaks' output in a single call — the integration
    // docs' own examples build one payload with `jq`. "The most recent run of semgrep on main" has
    // to mean one tool or it means nothing.
    await post({
      findings: [identifiableFinding(), identifiableFinding({ tool: "gitleaks", cwe: "CWE-798" })]
    });
    expect(scanRuns).toHaveLength(2);
    expect(scanRuns.map((r) => r.tool).sort()).toEqual(["gitleaks", "semgrep"]);
    expect(scanRuns.every((r) => r.findingCount === 1)).toBe(true);
  });
});

describe("where the finding says it belongs", () => {
  // Asserted here, and not in a fourth harness, because this file already drives the REAL router
  // against a real table — and "which module is on the row" is a statement about what ends up in
  // the table, which is exactly what this file's header says it exists to check. The resolution
  // itself is proved in finding-routing.test.ts; this is about the ingest storing the answer.

  function routeEverythingToBilling() {
    repositoryMaps.push({ id: "repo-1", pattern: "acme/**", projectId: "project-billing", isActive: true, order: 1, createdAt: new Date(2026, 0, 1) });
    modulePathRules.push({
      id: "path-1",
      projectId: "project-billing",
      pattern: "src/db/**",
      moduleId: "module-data",
      submoduleId: "submodule-queries",
      isActive: true,
      order: 1,
      createdAt: new Date(2026, 0, 1)
    });
  }

  it("stores the resolved module and submodule on the finding row itself", async () => {
    // On the ROW and not only on a ticket: most findings never become one, so a breakdown that read
    // the ticket would answer for a biased sample of the workspace's risk.
    routeEverythingToBilling();
    await post({ findings: [identifiableFinding()] });

    expect(findings[0].moduleId).toBe("module-data");
    expect(findings[0].submoduleId).toBe("submodule-queries");
  });

  it("stores a null module when no rule claims the path, and ingests it all the same", async () => {
    routeEverythingToBilling();
    const res = await post({ findings: [identifiableFinding({ filePath: "docs/README.md", cwe: "CWE-200" })] });

    expect(res.body).toEqual({ ingested: 1, created: 1, updated: 0 });
    expect(findings[0].moduleId ?? null).toBeNull();
  });

  it("ingests unchanged for a workspace with no rules at all", async () => {
    // The regression that protects existing customers, at the ingest layer: nothing configured
    // means nothing routed and nothing different.
    const res = await post({ findings: [identifiableFinding()] });

    expect(res.body).toEqual({ ingested: 1, created: 1, updated: 0 });
    expect(findings[0].moduleId ?? null).toBeNull();
    expect(findings[0].submoduleId ?? null).toBeNull();
  });

  it("lets a later scan adopt a module the first sighting could not have had", async () => {
    // A finding ingested before anybody wrote a rule picks one up the next time it is reported,
    // which is what fills the per-module breakdown in for an existing backlog.
    await post({ findings: [identifiableFinding()] });
    expect(findings[0].moduleId ?? null).toBeNull();

    routeEverythingToBilling();
    await post({ findings: [identifiableFinding()] });

    expect(findings).toHaveLength(1);
    expect(findings[0].moduleId).toBe("module-data");
  });
});

describe("what the verification verdict is handed", () => {
  // The seam between the ingest and the verdict. The verdict decides a finding is FIXED because its
  // fingerprint is absent from this list, so handing it the wrong list — one run's fingerprints
  // against another run's id — would mark real vulnerabilities resolved. Nothing inside the verdict
  // can detect that; only this can.

  it("gives each run exactly the fingerprints that run reported, and nobody else's", async () => {
    await post({
      findings: [identifiableFinding(), identifiableFinding({ tool: "gitleaks", cwe: "CWE-798" })]
    });

    expect(verifyFindingsAgainstScanRun).toHaveBeenCalledTimes(2);
    const semgrepRun = scanRuns.find((r) => r.tool === "semgrep")!;
    const gitleaksRun = scanRuns.find((r) => r.tool === "gitleaks")!;
    const byRunId = new Map(verifyFindingsAgainstScanRun.mock.calls.map((call) => [call[0], call[1] as string[]]));

    expect(byRunId.get(semgrepRun.id)).toEqual([findings.find((f) => f.tool === "semgrep")!.fingerprint]);
    expect(byRunId.get(gitleaksRun.id)).toEqual([findings.find((f) => f.tool === "gitleaks")!.fingerprint]);
  });

  it("still runs for a scan whose findings could not be identified, with an empty list", async () => {
    // No file path and no CWE: no fingerprint. The run still HAPPENED, and skipping the verdict for
    // it would mean a tool that reports only unidentifiable findings silently stops confirming
    // anything it used to confirm.
    await post({ findings: [{ type: "SAST", tool: "gitleaks", severity: "HIGH", title: "Secret detected" }] });

    expect(verifyFindingsAgainstScanRun).toHaveBeenCalledTimes(1);
    expect(verifyFindingsAgainstScanRun.mock.calls[0][1]).toEqual([]);
  });
});
