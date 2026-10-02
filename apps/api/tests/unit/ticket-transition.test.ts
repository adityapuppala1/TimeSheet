/**
 * One status-transition path for every writer.
 *
 * Four surfaces move a ticket's status: the app's own route, the public REST API, the MCP tool an
 * assistant calls, and the security-ingestion auto-reopen. Each used to carry its own copy of the
 * rules and each copy had drifted — the API and MCP skipped the participants' notifications, the
 * findings gate and the close digest; MCP wrote no audit row and the API wrote a different action,
 * so every metric replaying `ticket.status_changed` was blind to both; nothing guarded a change's
 * own ticket; and no reopen ever cleared `slaBreachAt`.
 *
 * Every assertion here is made on more than one surface on purpose: a rule that holds on the route
 * and not on the API is the exact defect this file exists to stop coming back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "assignee-1", name: "Priya", email: "priya@acme.test", role: "EMPLOYEE", permissions: [] as string[] };

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] };
      next();
    }
  };
});
// The key itself is not under test (public-api-key-expiry.test.ts owns that); what a WRITE key may
// do to a ticket is.
vi.mock("../../src/middleware/public-api-auth.js", () => ({
  publicApiAuth: (req: any, _res: express.Response, next: express.NextFunction) => {
    req.apiKey = { id: "key-1", scope: "WRITE" };
    next();
  },
  requireWriteScope: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
}));
const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
const notifySpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: (...a: unknown[]) => notifySpy(...a),
  dispatchTransactional: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/face.service.js", () => ({
  isFaceVerificationRequired: vi.fn().mockResolvedValue(false),
  consumeVerification: vi.fn(),
  bindVerificationToRecord: vi.fn()
}));
vi.mock("../../src/services/webhook-dispatch.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/webhook-dispatch.service.js")>()),
  dispatchOutboundWebhooks: vi.fn().mockResolvedValue(undefined)
}));
const markFindingsSpy = vi.fn().mockResolvedValue(undefined);
const closedDigestSpy = vi.fn().mockResolvedValue(undefined);
// The real module, so `maybeReopenTicketOnRegression` runs for real; only the two side effects the
// transition triggers are observed rather than performed.
vi.mock("../../src/services/security-report.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/security-report.service.js")>()),
  markFindingsAwaitingVerification: (...a: unknown[]) => markFindingsSpy(...a),
  sendTicketClosedDigest: (...a: unknown[]) => closedDigestSpy(...a)
}));

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { publicApiRouter } = await import("../../src/controllers/public-api.controller.js");
const { invokeMcpTool } = await import("../../src/services/mcp-tools.js");
const { maybeReopenTicketOnRegression } = await import("../../src/services/security-report.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const SLA = { slaLowHours: 10, slaMediumHours: 20, slaHighHours: 30, slaCriticalHours: 40 };
const HOUR = 3_600_000;

let row: Record<string, any>;
let client: PrismaClient;

function freshTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    key: "WEB-12",
    title: "Login broken",
    type: "BUG",
    description: null,
    projectId: "proj-1",
    status: "RESOLVED",
    priority: "HIGH",
    reporterId: "reporter-1",
    assigneeId: "assignee-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    // Resolved on time weeks ago, and breached once before that: the two facts a reopen has to reset.
    dueAt: new Date("2026-01-02T06:00:00Z"),
    slaBreachAt: new Date("2026-01-02T06:15:00Z"),
    resolvedAt: new Date("2026-01-05T00:00:00Z"),
    closedAt: null,
    needsReview: false,
    deletedAt: null,
    watchers: [{ userId: "watcher-1" }],
    collaborators: [{ userId: "collab-1" }],
    changeRequest: null,
    ...overrides
  };
}

function buildClient(): PrismaClient {
  return {
    ticket: {
      findFirst: vi.fn(async () => (row ? { ...row } : null)),
      findUniqueOrThrow: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data };
        return { ...row };
      })
    },
    // The acting employee is on proj-1, the ticket's project.
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "proj-1" }]), findFirst: vi.fn().mockResolvedValue({ id: "a-1" }) },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue({ id: "api-owner", name: "Integration owner", email: "owner@acme.test" })
    },
    ticketCollaborator: { findFirst: vi.fn().mockResolvedValue(null) },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue(SLA), findUnique: vi.fn().mockResolvedValue(null) },
    testRun: { findFirst: vi.fn().mockResolvedValue(null) },
    ticketBranch: { findMany: vi.fn().mockResolvedValue([]) },
    ticketComment: { findFirst: vi.fn().mockResolvedValue(null) },
    apiKey: { findUnique: vi.fn().mockResolvedValue({ id: "key-1", createdById: "api-owner" }) },
    ingestionSettings: { findUnique: vi.fn().mockResolvedValue({ id: "global", autoReopenEnabled: true }) },
    mcpToolInvocation: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() }
  } as unknown as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/tickets", ticketRouter);
  app.use("/api/public/v1", publicApiRouter);
  app.use(errorHandler);
  return app;
}

const MCP_SETTINGS = { enabled: true, allowWrites: true, toolOverrides: { transition_ticket: true } };

function mcpTransition(status: string) {
  const user = { ...actor, permissions: [...actor.permissions] };
  return runInTenant(client, () =>
    invokeMcpTool({ user, req: { user }, caller: { kind: "MCP_CREDENTIAL", id: "cred-1" } }, "transition_ticket", { ticketKey: "WEB-12", status }, MCP_SETTINGS)
  );
}

/** The four ways a ticket's status can move, each driven through its real entry point. */
const SURFACES = {
  ui: (status: string) => request(buildApp()).patch(`/api/tickets/${TICKET_ID}/status`).send({ status }),
  api: (status: string) => request(buildApp()).patch("/api/public/v1/tickets/WEB-12/status").send({ status }),
  mcp: mcpTransition
} as const;

const updateCalls = () => vi.mocked(client.ticket.update).mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
const statusAudits = () => auditSpy.mock.calls.filter((c) => String(c[1]).startsWith("ticket.status_changed"));
/** The (actor, action, entity, id, metadata) of each status audit — provenance asserted separately. */
const statusAuditRows = () => statusAudits().map((c) => c.slice(0, 5));

beforeEach(() => {
  vi.clearAllMocks();
  actor.id = "assignee-1";
  actor.role = "EMPLOYEE";
  actor.permissions = [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE];
  row = freshTicket();
  client = buildClient();
});

describe("a change's own ticket is moved from the change, on every writer", () => {
  beforeEach(() => {
    row = freshTicket({ status: "IN_REVIEW", type: "CHANGE", changeRequest: { id: "chg-1" } });
  });

  it("the Tickets page route refuses with 409 CHANGE_OWNED_TICKET and writes nothing", async () => {
    const res = await SURFACES.ui("RESOLVED");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHANGE_OWNED_TICKET");
    expect(res.body.message).toMatch(/Move it from the change/);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("the public API refuses the same way", async () => {
    const res = await SURFACES.api("RESOLVED");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CHANGE_OWNED_TICKET");
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("the MCP tool refuses the same way", async () => {
    await expect(SURFACES.mcp("RESOLVED")).rejects.toThrow(/Move it from the change/);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("the security auto-reopen declines rather than reopening a change behind its approver's back", async () => {
    row = freshTicket({ status: "CLOSED", type: "CHANGE", changeRequest: { id: "chg-1" } });
    const moved = await runInTenant(client, () => maybeReopenTicketOnRegression(TICKET_ID, "A failed github-actions test run"));
    expect(moved).toBe(false);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });
});

describe("reopening restarts the SLA clock and clears the old breach", () => {
  for (const surface of ["ui", "api", "mcp"] as const) {
    it(`via ${surface}: dueAt becomes now + the HIGH window, and slaBreachAt is cleared`, async () => {
      const before = Date.now();
      await SURFACES[surface]("REOPENED");
      const data = updateCalls()[0];
      expect(data.status).toBe("REOPENED");
      expect(data.slaBreachAt).toBeNull();
      const due = (data.dueAt as Date).getTime();
      expect(due).toBeGreaterThanOrEqual(before + 30 * HOUR);
      expect(due).toBeLessThanOrEqual(Date.now() + 30 * HOUR);
    });
  }

  it("via the security auto-reopen as well", async () => {
    const before = Date.now();
    const moved = await runInTenant(client, () => maybeReopenTicketOnRegression(TICKET_ID, "A failed github-actions test run"));
    expect(moved).toBe(true);
    const data = updateCalls()[0];
    expect(data).toMatchObject({ status: "REOPENED", slaBreachAt: null, resolvedAt: null, closedAt: null });
    expect((data.dueAt as Date).getTime()).toBeGreaterThanOrEqual(before + 30 * HOUR);
  });

  it("an ordinary forward move leaves the clock alone", async () => {
    row = freshTicket({ status: "OPEN", slaBreachAt: null, resolvedAt: null });
    await SURFACES.ui("IN_PROGRESS");
    const data = updateCalls()[0];
    expect(data).not.toHaveProperty("dueAt");
    expect(data).not.toHaveProperty("slaBreachAt");
  });
});

describe("every surface records the move as one audit action", () => {
  it("the public API writes ticket.status_changed, attributed to the key's creator and marked via api", async () => {
    await SURFACES.api("CLOSED");
    expect(statusAuditRows()).toEqual([
      ["api-owner", "ticket.status_changed", "Ticket", TICKET_ID, expect.objectContaining({ from: "RESOLVED", to: "CLOSED", via: "api", apiKeyId: "key-1" })]
    ]);
  });

  it("MCP writes ticket.status_changed on the Ticket, marked via mcp", async () => {
    await SURFACES.mcp("CLOSED");
    expect(statusAuditRows()).toEqual([
      ["assignee-1", "ticket.status_changed", "Ticket", TICKET_ID, expect.objectContaining({ from: "RESOLVED", to: "CLOSED", via: "mcp" })]
    ]);
  });

  it("the app's own route marks itself via ui", async () => {
    await SURFACES.ui("CLOSED");
    expect(statusAudits()[0][4]).toMatchObject({ from: "RESOLVED", to: "CLOSED", via: "ui" });
  });

  it("the auto-reopen writes the same action as an integration, with its reason", async () => {
    await runInTenant(client, () => maybeReopenTicketOnRegression(TICKET_ID, "A new CRITICAL SAST finding from semgrep"));
    expect(statusAudits()).toEqual([
      [
        undefined,
        "ticket.status_changed",
        "Ticket",
        TICKET_ID,
        expect.objectContaining({ from: "RESOLVED", to: "REOPENED", via: "auto_reopen", reason: "A new CRITICAL SAST finding from semgrep" }),
        expect.objectContaining({ actorType: "INTEGRATION" })
      ]
    ]);
  });
});

describe("the side effects the UI route performed now happen on every surface", () => {
  it("an API resolve marks the ticket's findings awaiting verification", async () => {
    row = freshTicket({ status: "IN_REVIEW", resolvedAt: null });
    const res = await SURFACES.api("RESOLVED");
    expect(res.status).toBe(200);
    expect(markFindingsSpy).toHaveBeenCalledWith({ id: TICKET_ID, key: "WEB-12" }, "api-owner");
  });

  it("an MCP resolve does too", async () => {
    row = freshTicket({ status: "IN_REVIEW", resolvedAt: null });
    await SURFACES.mcp("RESOLVED");
    expect(markFindingsSpy).toHaveBeenCalledWith({ id: TICKET_ID, key: "WEB-12" }, "assignee-1");
  });

  it("an API close sends the closed digest, naming the key's creator as the closer", async () => {
    await SURFACES.api("CLOSED");
    expect(closedDigestSpy).toHaveBeenCalledWith(
      { id: TICKET_ID, key: "WEB-12", title: "Login broken" },
      { id: "api-owner", name: "Integration owner", email: "owner@acme.test" }
    );
  });

  for (const surface of ["api", "mcp"] as const) {
    it(`a ${surface} move notifies the reporter, watchers and collaborators (not the actor)`, async () => {
      await SURFACES[surface]("CLOSED");
      const told = notifySpy.mock.calls.map((c) => (c[0] as { userId: string }).userId).sort();
      const expected = surface === "api" ? ["assignee-1", "collab-1", "reporter-1", "watcher-1"] : ["collab-1", "reporter-1", "watcher-1"];
      expect(told).toEqual(expected);
    });
  }

  it("the auto-reopen tells everyone on the ticket, not just the assignee", async () => {
    await runInTenant(client, () => maybeReopenTicketOnRegression(TICKET_ID, "A failed github-actions test run"));
    const told = notifySpy.mock.calls.map((c) => (c[0] as { userId: string }).userId).sort();
    expect(told).toEqual(["assignee-1", "collab-1", "reporter-1", "watcher-1"]);
  });
});

describe("the closed-to-reopened right is the same on every person-driven surface", () => {
  it("MCP refuses an employee without tickets:assign reopening a CLOSED ticket, as the route always did", async () => {
    row = freshTicket({ status: "CLOSED", closedAt: new Date("2026-01-06T00:00:00Z") });
    await expect(SURFACES.mcp("REOPENED")).rejects.toThrow(/Only an assigner or admin/);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  it("the route still refuses it", async () => {
    row = freshTicket({ status: "CLOSED", closedAt: new Date("2026-01-06T00:00:00Z") });
    const res = await SURFACES.ui("REOPENED");
    expect(res.status).toBe(403);
  });
});
