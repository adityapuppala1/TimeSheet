/**
 * SonarQube and ESLint, ingested natively.
 *
 * Sonar's webhook is a QUALITY GATE payload, not SARIF, and its issues come from a completely
 * different endpoint again. Before this, neither could reach TimeSphere without a customer writing
 * `jq` to translate them — and a translation step written by a customer is a translation step that
 * rots silently. So both are accepted verbatim, and this file drives the REAL router against an
 * in-memory stand-in for the models it writes, the same method devops-ingest-dedup.test.ts uses and
 * for the same reason: what is under test is what ends up in the table, and a test that counts mock
 * calls cannot tell a correct mapping from a plausible one.
 *
 * The four things that are easy to get wrong and expensive to get wrong, all asserted here:
 *
 *   1. WHICH DISCIPLINE AN ISSUE LANDS IN. Sonar's own taxonomy already carries it — VULNERABILITY
 *      is static analysis finding a vulnerability and belongs in the security numbers; BUG and
 *      CODE_SMELL are maintainability and must not. Get this backwards and a linter quietly becomes
 *      the largest contributor to a workspace's security risk score.
 *   2. THE COMPONENT SPLIT. `component` is `projectKey:path`, and a Maven-style project key contains
 *      colons of its own. Split on the first one and every path carries a module prefix: no routing
 *      rule matches it, and it fingerprints differently from the same file reported by any other
 *      tool.
 *   3. LINT SEVERITY. An ESLint error must not read as a security HIGH — CRITICAL/HIGH is the bar
 *      that opens tickets and spends AI budget.
 *   4. PATH NORMALISATION. ESLint reports absolute paths from whichever machine ran it. Two runners,
 *      two paths, two fingerprints, no deduplication — and therefore a verification ladder that can
 *      never conclude anything, because the "next scan" reports a finding it cannot recognise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface FindingRow {
  id: string;
  type: string;
  tool: string;
  severity: string;
  title: string;
  description: string | null;
  fingerprint: string | null;
  filePath: string | null;
  lineNumber: number | null;
  repository: string | null;
  branch: string | null;
  occurrences: number;
  aiTriagedAt: Date | null;
  [key: string]: unknown;
}

const findings: FindingRow[] = [];
const scanRuns: Array<Record<string, unknown>> = [];
const qualityGateRuns: Array<Record<string, unknown>> = [];
let seq = 0;

/** Prisma's `findFirst` semantics for the three columns the ingest looks up on — `null` means
 *  IS NULL, not "any value". Same stand-in as devops-ingest-dedup.test.ts. */
function matches(row: FindingRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => (row[key] ?? null) === (value ?? null));
}

vi.mock("../../src/config/prisma.js", () => ({
  getTenantClient: vi.fn().mockResolvedValue({}),
  prisma: {
    ingestionSettings: { findUnique: vi.fn().mockResolvedValue({ encryptedToken: "token" }) },
    ticket: { findFirst: vi.fn().mockResolvedValue(null) },
    repositoryMap: { findMany: vi.fn().mockResolvedValue([]) },
    modulePathRule: { findMany: vi.fn().mockResolvedValue([]) },
    scanRun: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = { id: `run-${seq}`, ...data };
        scanRuns.push(row);
        return row;
      })
    },
    qualityGateRun: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = { id: `gate-${seq}`, ...data };
        qualityGateRuns.push(row);
        return row;
      })
    },
    securityFinding: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row: FindingRow = {
          id: `finding-${seq}`,
          type: "SAST",
          tool: "",
          severity: "LOW",
          title: "",
          description: null,
          fingerprint: null,
          filePath: null,
          lineNumber: null,
          repository: null,
          branch: null,
          occurrences: 1,
          aiTriagedAt: null,
          ...data
        };
        findings.push(row);
        return row;
      }),
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => findings.find((row) => matches(row, where)) ?? null),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = findings.find((f) => f.id === where.id)!;
        for (const [key, value] of Object.entries(data)) {
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
vi.mock("../../src/services/security-report.service.js", () => ({
  maybeAssignFindingViaCodeowners: vi.fn().mockResolvedValue(undefined),
  maybeAutoCreateTicketForCiFailure: vi.fn().mockResolvedValue(undefined),
  maybeAutoCreateTicketForFinding: vi.fn().mockResolvedValue(undefined),
  maybePostCiFailureTriageComment: vi.fn().mockResolvedValue(undefined),
  maybeReopenTicketOnRegression: vi.fn().mockResolvedValue(undefined),
  maybeTriageFindingWithAI: vi.fn().mockResolvedValue(undefined),
  verifyFindingsAgainstScanRun: vi.fn().mockResolvedValue(undefined)
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

function post(path: string, body: unknown, expected = 201) {
  return request(app()).post(`/devops/acme${path}`).set("Authorization", "Bearer token").send(body as object).expect(expected);
}

/** One issue in the shape `/api/issues/search` actually returns. */
function sonarIssue(over: Record<string, unknown> = {}) {
  return {
    key: "AY9x-abcdef",
    rule: "javasecurity:S3649",
    severity: "BLOCKER",
    component: "com.acme:my-module:src/db/query.ts",
    project: "com.acme",
    line: 120,
    message: "Change this code to not construct SQL queries directly from user-controlled data.",
    type: "VULNERABILITY",
    effort: "30min",
    tags: ["cwe", "sql"],
    ...over
  };
}

beforeEach(() => {
  findings.length = 0;
  scanRuns.length = 0;
  qualityGateRuns.length = 0;
  seq = 0;
});

describe("SonarQube issues", () => {
  it("routes each issue by Sonar's own type — a vulnerability is security, a code smell is not", async () => {
    const res = await post("/findings/sonar", {
      issues: [
        sonarIssue(),
        sonarIssue({ key: "b", rule: "typescript:S1234", type: "CODE_SMELL", severity: "MINOR", component: "com.acme:my-module:src/ui/App.tsx", line: 12 }),
        sonarIssue({ key: "c", rule: "typescript:S9999", type: "BUG", severity: "MAJOR", component: "com.acme:my-module:src/ui/Form.tsx", line: 40 })
      ],
      repository: "acme/api",
      branch: "main"
    });
    expect(res.body).toEqual({ ingested: 3, created: 3, updated: 0 });

    expect(findings).toHaveLength(3);

    // THE ASSERTION THIS MAPPING EXISTS FOR. VULNERABILITY is static analysis finding a
    // vulnerability, so it counts in the security numbers exactly like a Semgrep result.
    const vuln = findings.find((f) => f.title.startsWith("Change this code"))!;
    expect(vuln.type).toBe("SAST");
    expect(vuln.severity).toBe("CRITICAL"); // BLOCKER

    // And the two maintainability types are emphatically NOT security. Getting this backwards is
    // how a thousand code smells become a workspace's security posture.
    const smell = findings.find((f) => f.filePath === "src/ui/App.tsx")!;
    expect(smell.type).toBe("QUALITY");
    expect(smell.severity).toBe("MEDIUM"); // MINOR

    const bug = findings.find((f) => f.filePath === "src/ui/Form.tsx")!;
    expect(bug.type).toBe("QUALITY");
    expect(bug.severity).toBe("HIGH"); // MAJOR
  });

  it("splits `component` on the LAST colon, because a project key contains colons of its own", async () => {
    await post("/findings/sonar", { issues: [sonarIssue()], repository: "acme/api", branch: "main" });
    // `com.acme:my-module:src/db/query.ts`. Split on the FIRST colon and this reads
    // `my-module:src/db/query.ts` — a path no routing rule matches and no other tool would ever
    // report, so the same finding from Semgrep and from Sonar becomes two rows forever.
    expect(findings[0].filePath).toBe("src/db/query.ts");
  });

  it("maps all five Sonar severities onto the four this app has", async () => {
    const severities = ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"];
    await post("/findings/sonar", {
      issues: severities.map((severity, i) =>
        sonarIssue({ key: `s-${i}`, severity, type: "CODE_SMELL", component: `com.acme:src/file-${i}.ts`, line: 10 })
      )
    });
    expect(findings.map((f) => f.severity)).toEqual(["CRITICAL", "CRITICAL", "HIGH", "MEDIUM", "LOW"]);
  });

  it("identifies an issue by its RULE, not by Sonar's issue key or its message text", async () => {
    // Sonar re-keys an issue when it moves, and its message interpolates the offending symbol. Key
    // the identity on either and a re-scan of unchanged code produces a brand-new finding.
    await post("/findings/sonar", { issues: [sonarIssue()], repository: "acme/api", branch: "main" });
    await post("/findings/sonar", {
      issues: [sonarIssue({ key: "totally-different-key", message: "Change this code to not construct SQL queries directly from `userId`." })],
      repository: "acme/api",
      branch: "main"
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].occurrences).toBe(2);
  });

  it("records a run for an analysis that found nothing, rather than treating it as a no-op", async () => {
    const res = await post("/findings/sonar", { issues: [], repository: "acme/api", branch: "main" });
    expect(res.body.ingested).toBe(0);

    // One run per type Sonar can produce, because the verdict is restricted to a run's own type. A
    // single SAST run would clear the security backlog on this branch and leave every QUALITY
    // finding waiting forever for proof that had already arrived.
    expect(scanRuns.map((run) => run.type).sort()).toEqual(["QUALITY", "SAST"]);
    for (const run of scanRuns) {
      expect(run).toMatchObject({ tool: "sonarqube", findingCount: 0, repository: "acme/api", branch: "main" });
    }
  });
});

describe("ESLint output", () => {
  /** `eslint --format json` is a bare array at the top level. */
  const eslintResults = [
    {
      filePath: "/home/runner/work/api/api/src/db/query.ts",
      messages: [
        { ruleId: "no-unused-vars", severity: 2, message: "'userId' is assigned a value but never used.", line: 12, column: 7 },
        { ruleId: "eqeqeq", severity: 1, message: "Expected '===' and instead saw '=='.", line: 40, column: 3 }
      ]
    }
  ];

  it("accepts the bare array eslint actually emits", async () => {
    const res = await post("/findings/eslint", eslintResults);
    expect(res.body).toEqual({ ingested: 2, created: 2, updated: 0 });
    expect(findings.every((f) => f.type === "LINT")).toBe(true);
    expect(findings.every((f) => f.tool === "eslint")).toBe(true);
  });

  it("keeps lint below the CRITICAL/HIGH bar — error is MEDIUM, warning is LOW", async () => {
    // The bar matters beyond presentation: CRITICAL/HIGH is what auto-creates tickets and what
    // spends AI triage budget. One lint run on a legacy repository would do both a thousand times.
    await post("/findings/eslint", eslintResults);
    const error = findings.find((f) => f.title.startsWith("'userId'"))!;
    const warning = findings.find((f) => f.title.startsWith("Expected"))!;
    expect(error.severity).toBe("MEDIUM");
    expect(warning.severity).toBe("LOW");
  });

  it("identifies a message by its RULE, not by its text", async () => {
    const oneMessage = (message: string, ruleId = "no-unused-vars") => [
      { filePath: "/home/runner/work/api/api/src/db/query.ts", messages: [{ ruleId, severity: 2, message, line: 12, column: 7 }] }
    ];
    await post("/findings/eslint", oneMessage("'userId' is assigned a value but never used."));
    // Same rule, same file, same line — the message reworded because the variable was renamed. That
    // is the SAME problem, and hashing the message would call it a new one on every rename.
    await post("/findings/eslint", oneMessage("'accountId' is assigned a value but never used."));
    expect(findings).toHaveLength(1);
    expect(findings[0].occurrences).toBe(2);

    // A different rule on the same line is a different problem, and gets its own row.
    await post("/findings/eslint", oneMessage("Expected '===' and instead saw '=='.", "eqeqeq"));
    expect(findings).toHaveLength(2);
  });

  it("normalises absolute paths so two runners report the SAME finding, not two", async () => {
    // The failure this prevents is total and silent: different paths mean different fingerprints,
    // which means no deduplication, which means the verification ladder waits forever for a scan
    // that has already arrived under another name.
    await post("/findings/eslint", {
      results: [{ filePath: "/home/runner/work/api/api/src/db/query.ts", messages: [{ ruleId: "eqeqeq", severity: 2, message: "x", line: 40 }] }],
      rootPath: "/home/runner/work/api/api"
    });
    await post("/findings/eslint", {
      results: [{ filePath: "D:\\a\\api\\api\\src\\db\\query.ts", messages: [{ ruleId: "eqeqeq", severity: 2, message: "x", line: 40 }] }],
      rootPath: "D:\\a\\api\\api"
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].filePath).toBe("src/db/query.ts");
    expect(findings[0].occurrences).toBe(2);
  });

  it("records a run for a clean lint pass", async () => {
    const res = await post("/findings/eslint", [{ filePath: "/repo/src/ok.ts", messages: [] }]);
    expect(res.body.ingested).toBe(0);
    expect(scanRuns).toHaveLength(1);
    expect(scanRuns[0]).toMatchObject({ tool: "eslint", type: "LINT", findingCount: 0 });
  });
});

describe("the SonarQube quality-gate webhook", () => {
  /** Sonar's payload, verbatim — the shape a customer's server actually POSTs. */
  const payload = {
    serverUrl: "https://sonar.acme.internal",
    taskId: "AY9xQ2m1",
    status: "SUCCESS",
    analysedAt: "2026-08-30T09:15:00+0000",
    revision: "4f2a91c0be31aa7c",
    project: { key: "com.acme:my-module", name: "My Module", url: "https://sonar.acme.internal/dashboard?id=com.acme" },
    branch: { name: "feature/WEB-123-intake", type: "BRANCH", isMain: false, url: "https://sonar.acme.internal/dashboard?branch=x" },
    qualityGate: {
      name: "Acme way",
      status: "ERROR",
      conditions: [
        { metric: "new_coverage", operator: "LESS_THAN", value: "62.1", status: "ERROR", errorThreshold: "80" },
        { metric: "new_bugs", operator: "GREATER_THAN", value: "0", status: "OK", errorThreshold: "0" }
      ]
    },
    properties: {}
  };

  it("stores the payload as it arrived — project, branch, revision, verdict and conditions", async () => {
    const res = await post("/quality-gate", payload);
    expect(res.body).toMatchObject({ projectKey: "com.acme:my-module", branch: "feature/WEB-123-intake", status: "ERROR", analysisStatus: "SUCCESS" });

    expect(qualityGateRuns).toHaveLength(1);
    const run = qualityGateRuns[0];
    expect(run).toMatchObject({
      provider: "sonarqube",
      serverUrl: "https://sonar.acme.internal",
      taskId: "AY9xQ2m1",
      projectKey: "com.acme:my-module",
      projectName: "My Module",
      branch: "feature/WEB-123-intake",
      // Sonar calls it `revision`; it is a commit sha and it is stored under this schema's own name.
      commitSha: "4f2a91c0be31aa7c",
      gateName: "Acme way",
      status: "ERROR"
    });
    expect((run.conditions as unknown[])).toHaveLength(2);
    expect(run.analysedAt).toBeInstanceOf(Date);
  });

  it("accepts the payload of a FAILED analysis, which carries no quality gate at all", async () => {
    // Sonar sends this when its own task died. Rejecting it would leave the operator with a red
    // arrow in Sonar's admin UI and no body to read; storing it means the resolve gate can see that
    // the last thing that happened on this branch was an analysis failure, and ignore it.
    await post("/quality-gate", { status: "FAILED", project: { key: "com.acme" }, properties: {} });
    expect(qualityGateRuns).toHaveLength(1);
    expect(qualityGateRuns[0]).toMatchObject({ analysisStatus: "FAILED", status: "WARN" });
  });

  it("refuses a payload with no project key, which is the one field nothing can work without", async () => {
    await post("/quality-gate", { status: "SUCCESS", qualityGate: { status: "OK" } }, 422);
    expect(qualityGateRuns).toHaveLength(0);
  });
});

describe("what a CI token may post", () => {
  it("still refuses VAPT, which is a human-led assessment and not a thing a build script can claim", async () => {
    const res = await post(
      "/findings",
      { findings: [{ type: "VAPT", tool: "manual", severity: "CRITICAL", title: "Pentest finding" }] },
      422
    );
    expect(res.body.message).toMatch(/VAPT/);
  });

  it("accepts QUALITY and LINT, which is the entire point of this work", async () => {
    const res = await post("/findings", {
      findings: [
        { type: "QUALITY", tool: "sonarqube", severity: "MEDIUM", title: "Cognitive complexity too high", ruleId: "typescript:S3776", filePath: "src/a.ts", lineNumber: 4 },
        { type: "LINT", tool: "eslint", severity: "LOW", title: "Prefer const", ruleId: "prefer-const", filePath: "src/b.ts", lineNumber: 9 }
      ]
    });
    expect(res.body).toEqual({ ingested: 2, created: 2, updated: 0 });
  });
});
