/**
 * `POST /api/devops/:orgSlug/findings` accepts up to 500 findings and used to run the opt-in AI
 * exploitability triage for every one of them inside the same `Promise.all` as the row creation.
 *
 * That is the app's clearest denial-of-wallet shape, and it is reachable with nothing but a CI
 * ingestion token — the lowest-privilege credential the product issues, which lives in whatever CI
 * system an org pointed at this endpoint:
 *
 *  - The per-IP webhook limiter counts the whole batch as ONE request, so the throttle sees 1 while
 *    the provider sees ~500 model calls.
 *  - Worse, it defeated the budget cap rather than merely straining it. `preflight` reads the
 *    month's spend and compares it to the ceiling; `logAIUsage` writes the row that moves that
 *    number. Fired concurrently, all of them read the same total before any had written anything,
 *    so all of them passed a cap only one should have.
 *
 * Both assertions below are about the same two-line change: cap the fan-out, and run it
 * sequentially so each call's usage row lands before the next one's preflight reads it.
 *
 * ── WHAT MOVED WHEN FINDING DEDUPLICATION LANDED, AND WHAT DID NOT ────────────────────────────
 *
 * Ingestion is no longer an unconditional `create`: it derives a fingerprint, looks for an
 * existing row, and records a ScanRun. The Prisma stand-in below therefore grew `findFirst`,
 * `update` and `scanRun.create`, and the response body changed from `{ created }` to
 * `{ ingested, created, updated }` — deliberately, because "created" alone can no longer describe
 * an ingest where some findings were already known. The exact-match assertion is kept exact so a
 * future key cannot be added to that body without somebody choosing to.
 *
 * The two things this file actually exists to prove are untouched, because they are about spend
 * rather than storage: the fan-out is still capped, and it still runs strictly one at a time. The
 * 120 findings below carry no file path and no rule identity, so none of them can be fingerprinted
 * and all 120 are created — which is exactly the shape that produced the original 120-model-call
 * batch, and therefore still the right worst case to test the cap against.
 *
 * ── WHAT FINDING ROUTING ADDED, AND WHY IT IS ASSERTED HERE ───────────────────────────────────
 *
 * Each ingested finding now resolves a project/module from its repository and path. That is a
 * per-finding DECISION, and the danger was making it a per-finding QUERY: 500 findings behind one
 * throttled request is the same denial-of-wallet shape as the AI fan-out, just aimed at the
 * database. The rules are therefore read ONCE per batch and matched in memory, and there is an
 * assertion below that counts those reads — a regression to per-finding lookups would show up as
 * 120 instead of 1.
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const maybeTriageFindingWithAI = vi.fn();
/** The finding-routing rule reads. Named so the fan-out assertions can count them: routing is
 *  per-BATCH work, and a change that made it per-finding would be the same denial-of-wallet shape
 *  one layer down — 500 findings, 500 extra queries, one throttled request. */
const repositoryMapFindMany = vi.fn().mockResolvedValue([]);
const modulePathRuleFindMany = vi.fn().mockResolvedValue([]);
let concurrentTriageCalls = 0;
let peakConcurrentTriageCalls = 0;

maybeTriageFindingWithAI.mockImplementation(async () => {
  concurrentTriageCalls += 1;
  peakConcurrentTriageCalls = Math.max(peakConcurrentTriageCalls, concurrentTriageCalls);
  await new Promise((resolve) => setImmediate(resolve));
  concurrentTriageCalls -= 1;
});

let findingSeq = 0;

vi.mock("../../src/config/prisma.js", () => ({
  getTenantClient: vi.fn().mockResolvedValue({}),
  prisma: {
    ingestionSettings: { findUnique: vi.fn().mockResolvedValue({ encryptedToken: "token" }) },
    ticket: { findFirst: vi.fn().mockResolvedValue(null) },
    // The ingest reads the finding-routing rules ONCE for the whole batch and matches them in
    // memory (see services/finding-routing.service.ts). Empty here on purpose: this file is about
    // what one request costs, and a workspace with no routing rules is also the configuration whose
    // behaviour must be unchanged.
    repositoryMap: { findMany: repositoryMapFindMany },
    modulePathRule: { findMany: modulePathRuleFindMany },
    // The ingest records a run per (tool, type, repo, branch) group. All 120 findings below share
    // one group, so exactly one run is created and every finding links to it.
    scanRun: { create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "run-1", ...data })) },
    securityFinding: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        findingSeq += 1;
        return { id: `finding-${findingSeq}`, ticketId: null, ...data };
      }),
      // Nothing here is fingerprintable, so the dedup lookup never finds a prior row and `update`
      // is never reached. Both are present so that a change making these findings identifiable
      // fails on an assertion below rather than on a missing mock method. See
      // devops-ingest-dedup.test.ts for the deduplication behaviour itself.
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn()
    }
  }
}));
vi.mock("../../src/middleware/tenant.js", () => ({
  resolveActiveOrgBySlug: vi.fn().mockResolvedValue({ id: "org-1", slug: "acme", database: { encryptedDsn: "dsn" } })
}));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (value: string) => value }));
vi.mock("../../src/utils/security.js", () => ({ constantTimeEqual: () => true }));
vi.mock("../../src/services/security-report.service.js", () => ({
  // Resolved promises, not bare `vi.fn()` — the route chains `.catch()` onto each of these.
  maybeAssignFindingViaCodeowners: vi.fn().mockResolvedValue(undefined),
  maybeAutoCreateTicketForCiFailure: vi.fn().mockResolvedValue(undefined),
  maybeAutoCreateTicketForFinding: vi.fn().mockResolvedValue(undefined),
  maybePostCiFailureTriageComment: vi.fn().mockResolvedValue(undefined),
  maybeReopenTicketOnRegression: vi.fn().mockResolvedValue(undefined),
  maybeTriageFindingWithAI,
  // The verification verdict runs once per recorded ScanRun. Stubbed here rather than exercised:
  // this file is about the AI fan-out's cost and concurrency, and it is covered on its own in
  // finding-verification.test.ts.
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

function findings(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: "SAST",
    tool: "semgrep",
    severity: "CRITICAL",
    title: `Finding ${i}`
  }));
}

describe("AI triage fan-out on a findings batch", () => {
  it("bounds how many findings in one request may reach a model, while still ingesting them all", async () => {
    maybeTriageFindingWithAI.mockClear();
    peakConcurrentTriageCalls = 0;

    const res = await request(app())
      .post("/devops/acme/findings")
      .set("Authorization", "Bearer token")
      .send({ findings: findings(120) })
      .expect(201);

    // Every finding is still recorded — the cap is on the AI opinion, not the ingestion. `updated`
    // is 0 because none of these can be fingerprinted; see this file's header.
    expect(res.body).toEqual({ ingested: 120, created: 120, updated: 0 });
    expect(maybeTriageFindingWithAI.mock.calls.length).toBeLessThanOrEqual(20);
    expect(maybeTriageFindingWithAI.mock.calls.length).toBeGreaterThan(0);
  });

  it("reads the routing rules once for the whole batch, not once per finding", async () => {
    // Same argument as the cap above, applied to the database instead of the model provider: one
    // HTTP request the per-IP limiter counts once must not become 120 rule lookups. The rules are
    // read into memory and every finding is matched against that snapshot.
    repositoryMapFindMany.mockClear();
    modulePathRuleFindMany.mockClear();

    await request(app()).post("/devops/acme/findings").set("Authorization", "Bearer token").send({ findings: findings(120) }).expect(201);

    expect(repositoryMapFindMany).toHaveBeenCalledTimes(1);
    expect(modulePathRuleFindMany).toHaveBeenCalledTimes(1);
  });

  it("runs the triage calls one at a time so each one's spend is visible to the next one's budget check", async () => {
    maybeTriageFindingWithAI.mockClear();
    peakConcurrentTriageCalls = 0;

    await request(app())
      .post("/devops/acme/findings")
      .set("Authorization", "Bearer token")
      .send({ findings: findings(10) })
      .expect(201);

    expect(peakConcurrentTriageCalls).toBe(1);
  });
});
