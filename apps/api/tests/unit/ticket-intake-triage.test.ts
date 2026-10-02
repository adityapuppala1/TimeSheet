/**
 * Intake tickets can be triaged by the people asked to triage them.
 *
 * A low-confidence email, a chat message or a request-form submission lands in project P with the
 * seeded intake system account as its reporter and nobody assigned. The "needs review" email goes to
 * the workspace admins AND to every MANAGER and TEAM_LEAD on P, saying the ticket "needs a quick
 * human check before it's assigned". But the reassignment rule follows the reporting line, and a
 * system account reports to nobody — so every one of those managers got 403 on assign, on status
 * and on edit. The people the product asked to review the ticket could not touch it.
 *
 * The widening is deliberately narrow, and these tests pin both edges: it needs `tickets:assign`,
 * membership of the ticket's own project, and an intake ticket. A manager outside P, an employee in
 * P, and a manager in P looking at an ordinary ticket all keep exactly the answer they had.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "lead-1", name: "Lena", email: "lena@acme.test", role: "TEAM_LEAD", permissions: [] as string[] };

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
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
  dispatchTransactional: vi.fn().mockResolvedValue({ ok: true })
}));

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { canReassignTicket, canWorkOnTicket } = await import("../../src/services/ticket.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE = "22222222-2222-4222-8222-222222222222";
const INTAKE_REPORTER = "intake-system-user";

/** Who is assigned to which project. */
let memberships: Array<{ userId: string; projectId: string }>;
let ticket: Record<string, any>;
let client: PrismaClient;

function buildClient(): PrismaClient {
  const isMember = (userId: string, projectId: string) => memberships.some((m) => m.userId === userId && m.projectId === projectId);
  return {
    ticket: {
      findFirst: vi.fn(async () => ({ ...ticket })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ticket, ...data, assignee: null, project: null, module: null, reporter: null }))
    },
    userProjectAssignment: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) => memberships.filter((m) => where.userId.in.includes(m.userId))),
      findFirst: vi.fn(async ({ where }: { where: { userId: string; projectId: string } }) => (isMember(where.userId, where.projectId) ? { id: "a" } : null))
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      // Two questions reach here: "is this person the reporter's/assignee's manager?" (never, in
      // these tests — a system account reports to nobody) and "is this reporter an intake system
      // account?", answered by the email the seed gives those accounts.
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        if (where.managerId) return null;
        if (where.email?.in) {
          return where.id === INTAKE_REPORTER && where.email.in.includes("email-intake@system.local") ? { id: INTAKE_REPORTER } : null;
        }
        return null;
      })
    },
    ticketCollaborator: { findFirst: vi.fn().mockResolvedValue(null) }
  } as unknown as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/tickets", ticketRouter);
  app.use(errorHandler);
  return app;
}

const as = (role: string, id: string, perms: string[]) => ({ user: { id, role, permissions: perms } });
const MANAGER_PERMS = [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE, permissions.TICKETS_ASSIGN];

beforeEach(() => {
  vi.clearAllMocks();
  actor.id = "lead-1";
  actor.role = "TEAM_LEAD";
  actor.permissions = [...MANAGER_PERMS];
  memberships = [
    { userId: "lead-1", projectId: "proj-p" },
    { userId: "manager-1", projectId: "proj-p" },
    { userId: "employee-1", projectId: "proj-p" },
    { userId: ASSIGNEE, projectId: "proj-p" },
    { userId: "outsider-1", projectId: "proj-q" }
  ];
  // An email-intake ticket in P: reported by the system account, unassigned, flagged for review.
  ticket = {
    id: TICKET_ID,
    key: "P-7",
    title: "Invoice PDF is blank",
    type: "BUG",
    projectId: "proj-p",
    status: "OPEN",
    priority: "MEDIUM",
    reporterId: INTAKE_REPORTER,
    assigneeId: null,
    needsReview: true,
    deletedAt: null,
    createdAt: new Date()
  };
  client = buildClient();
});

describe("the route: assigning an intake ticket", () => {
  it("a TEAM_LEAD on project P can assign an intake ticket in P", async () => {
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}/assign`).send({ assigneeId: ASSIGNEE });
    expect(res.status).toBe(200);
    expect(client.ticket.update).toHaveBeenCalled();
  });

  it("a MANAGER on project P can too", async () => {
    actor.id = "manager-1";
    actor.role = "MANAGER";
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}/assign`).send({ assigneeId: ASSIGNEE });
    expect(res.status).toBe(200);
  });

  it("a manager outside P still gets 403 and writes nothing", async () => {
    actor.id = "outsider-1";
    actor.role = "MANAGER";
    const res = await request(buildApp()).patch(`/api/tickets/${TICKET_ID}/assign`).send({ assigneeId: ASSIGNEE });
    expect(res.status).toBe(403);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });
});

describe("the predicates", () => {
  it("let a project member holding tickets:assign triage and work an intake ticket", async () => {
    const lead = as("TEAM_LEAD", "lead-1", MANAGER_PERMS);
    await runInTenant(client, async () => {
      expect(await canReassignTicket(lead, ticket as any)).toBe(true);
      expect(await canWorkOnTicket(lead, ticket as any)).toBe(true);
    });
  });

  it("recognise an intake ticket by its system reporter even once the review flag is cleared", async () => {
    ticket.needsReview = false;
    await runInTenant(client, async () => {
      expect(await canReassignTicket(as("TEAM_LEAD", "lead-1", MANAGER_PERMS), ticket as any)).toBe(true);
    });
  });

  it("recognise a flagged ticket even when a person reported it", async () => {
    ticket.reporterId = "someone-1";
    await runInTenant(client, async () => {
      expect(await canReassignTicket(as("TEAM_LEAD", "lead-1", MANAGER_PERMS), ticket as any)).toBe(true);
    });
  });

  it("refuse a project member without tickets:assign", async () => {
    const employee = as("EMPLOYEE", "employee-1", [permissions.TICKETS_VIEW, permissions.TICKETS_WRITE]);
    await runInTenant(client, async () => {
      expect(await canReassignTicket(employee, ticket as any)).toBe(false);
      expect(await canWorkOnTicket(employee, ticket as any)).toBe(false);
    });
  });

  it("refuse a manager outside the ticket's project", async () => {
    await runInTenant(client, async () => {
      expect(await canReassignTicket(as("MANAGER", "outsider-1", MANAGER_PERMS), ticket as any)).toBe(false);
    });
  });

  it("leave an ordinary ticket on the reporting-line rule, even for a manager in its project", async () => {
    ticket.reporterId = "someone-1";
    ticket.needsReview = false;
    await runInTenant(client, async () => {
      expect(await canReassignTicket(as("TEAM_LEAD", "lead-1", MANAGER_PERMS), ticket as any)).toBe(false);
      expect(await canWorkOnTicket(as("TEAM_LEAD", "lead-1", MANAGER_PERMS), ticket as any)).toBe(false);
    });
  });
});
