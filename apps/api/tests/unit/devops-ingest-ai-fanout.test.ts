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
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const maybeTriageFindingWithAI = vi.fn();
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
    securityFinding: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        findingSeq += 1;
        return { id: `finding-${findingSeq}`, ticketId: null, ...data };
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
  // Resolved promises, not bare `vi.fn()` — the route chains `.catch()` onto each of these.
  maybeAssignFindingViaCodeowners: vi.fn().mockResolvedValue(undefined),
  maybeAutoCreateTicketForCiFailure: vi.fn().mockResolvedValue(undefined),
  maybeAutoCreateTicketForFinding: vi.fn().mockResolvedValue(undefined),
  maybePostCiFailureTriageComment: vi.fn().mockResolvedValue(undefined),
  maybeReopenTicketOnRegression: vi.fn().mockResolvedValue(undefined),
  maybeTriageFindingWithAI
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

    // Every finding is still recorded — the cap is on the AI opinion, not the ingestion.
    expect(res.body).toEqual({ created: 120 });
    expect(maybeTriageFindingWithAI.mock.calls.length).toBeLessThanOrEqual(20);
    expect(maybeTriageFindingWithAI.mock.calls.length).toBeGreaterThan(0);
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
