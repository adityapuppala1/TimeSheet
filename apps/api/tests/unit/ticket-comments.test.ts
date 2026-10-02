/**
 * Posting a comment is one act, whichever surface does it.
 *
 * The app's comment route told the reporter, the assignee and the watchers, recorded an audit row,
 * and handled @mentions. The other three ways a comment is posted — the MCP `add_ticket_comment`
 * tool, Ask AI's `comment_on_ticket`, and the public API — shared a helper whose doc comment said
 * "it notifies the ticket's participants" and which sent nothing and recorded nothing (the API wrote
 * its own `ticket.commented_via_api` row and still told nobody). A comment an assistant posts under
 * your name is still your comment: the people on the ticket must hear about it the same way.
 *
 * Collaborators are participants too. The status-change fan-out always included them; the comment
 * fan-out did not, so the people actively working a ticket missed the discussion on it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "author-1", name: "Priya", email: "priya@acme.test", role: "EMPLOYEE", permissions: [] as string[] };

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

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { publicApiRouter } = await import("../../src/controllers/public-api.controller.js");
const { invokeMcpTool } = await import("../../src/services/mcp-tools.js");
const { addTicketCommentForActor } = await import("../../src/services/ticket.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
/** Mentions carry real uuids (mentions.service.ts ignores anything else), so the watcher has one. */
const WATCHER = "33333333-3333-4333-8333-333333333333";
const TICKET = {
  id: TICKET_ID,
  key: "WEB-12",
  title: "Login broken",
  type: "BUG",
  projectId: "proj-1",
  status: "IN_PROGRESS",
  reporterId: "reporter-1",
  assigneeId: "assignee-1",
  deletedAt: null,
  watchers: [{ userId: WATCHER }],
  collaborators: [{ userId: "collab-1" }]
};

let client: PrismaClient;

function buildClient(): PrismaClient {
  return {
    ticket: { findFirst: vi.fn().mockResolvedValue(TICKET) },
    ticketComment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "comment-1", createdAt: new Date(), ...data }))
    },
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "proj-1" }]), findFirst: vi.fn().mockResolvedValue({ id: "a-1" }) },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "api-owner" ? { id: "api-owner", name: "Integration owner", email: "owner@acme.test" } : { id: where.id, name: "Priya" }
      )
    },
    apiKey: { findUnique: vi.fn().mockResolvedValue({ id: "key-1", createdById: "api-owner" }) },
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

const told = () => notifySpy.mock.calls.map((c) => (c[0] as { userId: string }).userId).sort();
const commentAudits = () => auditSpy.mock.calls.filter((c) => String(c[1]).startsWith("ticket.commented")).map((c) => c.slice(0, 5));

beforeEach(() => {
  vi.clearAllMocks();
  actor.permissions = [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE];
  client = buildClient();
});

describe("every surface tells the people on the ticket, collaborators included", () => {
  it("the app's own route", async () => {
    const res = await request(buildApp()).post(`/api/tickets/${TICKET_ID}/comments`).send({ body: "<p>Repro attached</p>" });
    expect(res.status).toBe(201);
    expect(told()).toEqual(["assignee-1", "collab-1", "reporter-1", WATCHER].sort());
  });

  it("the MCP add_ticket_comment tool", async () => {
    const user = { ...actor, permissions: [...actor.permissions] };
    await runInTenant(client, () =>
      invokeMcpTool({ user, req: { user }, caller: { kind: "MCP_CREDENTIAL", id: "cred-1" } }, "add_ticket_comment", { ticketKey: "WEB-12", body: "Root cause found" }, {
        enabled: true,
        allowWrites: true,
        toolOverrides: { add_ticket_comment: true }
      })
    );
    expect(told()).toEqual(["assignee-1", "collab-1", "reporter-1", WATCHER].sort());
  });

  it("Ask AI's comment_on_ticket, which reaches the same helper with no name on its context", async () => {
    await runInTenant(client, () =>
      addTicketCommentForActor({ user: { id: "author-1", role: "EMPLOYEE", permissions: [permissions.TICKETS_WRITE] } }, { ticketKey: "WEB-12", body: "Done on staging", via: "ai_chat" })
    );
    expect(told()).toEqual(["assignee-1", "collab-1", "reporter-1", WATCHER].sort());
    // The author's name is looked up rather than printed as "undefined commented on…".
    expect((notifySpy.mock.calls[0][0] as { body: string }).body).toMatch(/^Priya commented/);
  });

  it("the public API, which tells the assignee too since the key's creator is not on the ticket", async () => {
    const res = await request(buildApp()).post("/api/public/v1/tickets/WEB-12/comments").send({ body: "Deployed in build 512" });
    expect(res.status).toBe(201);
    expect(told()).toEqual(["assignee-1", "collab-1", "reporter-1", WATCHER].sort());
  });
});

describe("every surface records the comment as one audit action", () => {
  it("MCP writes ticket.commented, marked via mcp", async () => {
    const user = { ...actor, permissions: [...actor.permissions] };
    await runInTenant(client, () =>
      invokeMcpTool({ user, req: { user }, caller: { kind: "MCP_CREDENTIAL", id: "cred-1" } }, "add_ticket_comment", { ticketKey: "WEB-12", body: "Root cause found" }, {
        enabled: true,
        allowWrites: true,
        toolOverrides: { add_ticket_comment: true }
      })
    );
    expect(commentAudits()).toEqual([["author-1", "ticket.commented", "Ticket", TICKET_ID, expect.objectContaining({ commentId: "comment-1", via: "mcp" })]]);
  });

  it("the public API writes ticket.commented, marked via api with its key", async () => {
    await request(buildApp()).post("/api/public/v1/tickets/WEB-12/comments").send({ body: "Deployed in build 512" });
    expect(commentAudits()).toEqual([
      ["api-owner", "ticket.commented", "Ticket", TICKET_ID, expect.objectContaining({ commentId: "comment-1", via: "api", apiKeyId: "key-1" })]
    ]);
  });
});

describe("@mentions are honoured whichever surface posts the comment", () => {
  it("an MCP comment that mentions a project member notifies them personally, once", async () => {
    const user = { ...actor, permissions: [...actor.permissions] };
    const body = `<p>Over to <span data-mention-id="${WATCHER}" data-mention-label="Wen">@Wen</span></p>`;
    await runInTenant(client, () =>
      invokeMcpTool({ user, req: { user }, caller: { kind: "MCP_CREDENTIAL", id: "cred-1" } }, "add_ticket_comment", { ticketKey: "WEB-12", body }, {
        enabled: true,
        allowWrites: true,
        toolOverrides: { add_ticket_comment: true }
      })
    );
    const toWatcher = notifySpy.mock.calls.map((c) => c[0] as { userId: string; category: string }).filter((n) => n.userId === WATCHER);
    expect(toWatcher.map((n) => n.category)).toEqual(["ticket.mentioned"]);
  });
});
