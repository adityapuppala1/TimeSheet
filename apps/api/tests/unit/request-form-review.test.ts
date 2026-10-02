/**
 * The request-form review inbox.
 *
 * Three defects, all about the inbox being wider or weaker than the tickets behind it:
 *   1. GET /submissions was not project-scoped, so any `tickets:view` holder could read every
 *      form's submissions — submitter names, emails and answers — across the workspace.
 *   2. Reject soft-deleted the ticket with only `tickets:assign`, no project check and no status
 *      check, so a team lead outside project P could reject an ACCEPTED submission and delete an
 *      in-progress P ticket. Deleting a ticket anywhere else needs `tickets:manage` plus visibility.
 *   3. Accept cleared the SUBMISSION's review flag and not the TICKET's, so the "Review" badge on
 *      the ticket never went away (see ticket-needs-review.test.ts for the ticket side).
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
// The workspace toggle and plan quota are not what is under test.
vi.mock("../../src/services/planning.service.js", () => ({ assertPlanningCapability: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getPlanningQuota: vi.fn().mockResolvedValue(10) }));

const { requestFormRouter } = await import("../../src/controllers/request-form.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const SUB_P = "11111111-1111-4111-8111-111111111111";
const SUB_Q = "22222222-2222-4222-8222-222222222222";

interface SubmissionRow {
  id: string;
  status: string;
  ticketId: string | null;
  ticket: { id: string; projectId: string } | null;
  form: { id: string; projectId: string };
}

let submissions: SubmissionRow[];
let client: PrismaClient;

/** Evaluates exactly the project-scope clause the inbox query builds. */
function inScope(row: SubmissionRow, where: Record<string, any>): boolean {
  if (!where.OR) return true;
  return (where.OR as Array<Record<string, any>>).some((clause) => {
    if (clause.ticket) return Boolean(row.ticket) && clause.ticket.is.projectId.in.includes(row.ticket!.projectId);
    if (clause.ticketId === null) return !row.ticketId && clause.form.projectId.in.includes(row.form.projectId);
    return false;
  });
}

function buildClient(): PrismaClient {
  const tx = {
    requestFormSubmission: { update: vi.fn().mockResolvedValue({}) },
    ticket: { update: vi.fn().mockResolvedValue({}) }
  };
  return {
    requestFormSubmission: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => submissions.filter((s) => inScope(s, where))),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => submissions.find((s) => s.id === where.id) ?? null),
      update: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...submissions.find((s) => s.id === where.id), status: "ACCEPTED" }))
    },
    requestForm: { create: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    ticket: { update: vi.fn().mockResolvedValue({}) },
    // ticketProjectScope: the lead is on P only.
    user: { findMany: vi.fn().mockResolvedValue([]) },
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "proj-p" }]) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    _tx: tx
  } as unknown as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/request-forms", requestFormRouter);
  app.use(errorHandler);
  return app;
}

const tx = () => (client as any)._tx;

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "TEAM_LEAD";
  actor.permissions = [permissions.TICKETS_VIEW, permissions.TICKETS_ASSIGN];
  submissions = [
    { id: SUB_P, status: "PENDING", ticketId: "t-p", ticket: { id: "t-p", projectId: "proj-p" }, form: { id: "f-p", projectId: "proj-p" } },
    { id: SUB_Q, status: "PENDING", ticketId: "t-q", ticket: { id: "t-q", projectId: "proj-q" }, form: { id: "f-q", projectId: "proj-q" } }
  ];
  client = buildClient();
});

describe("GET /submissions is bounded by the caller's project scope", () => {
  it("returns only submissions whose ticket is in a project the caller can see", async () => {
    const res = await request(buildApp()).get("/api/request-forms/submissions");
    expect(res.status).toBe(200);
    expect(res.body.map((s: SubmissionRow) => s.id)).toEqual([SUB_P]);
  });

  it("is unrestricted for an admin", async () => {
    actor.role = "ADMIN";
    const res = await request(buildApp()).get("/api/request-forms/submissions");
    expect(res.body.map((s: SubmissionRow) => s.id)).toEqual([SUB_P, SUB_Q]);
  });
});

describe("rejecting a submission", () => {
  it("is refused outside the caller's project scope, and deletes nothing", async () => {
    const res = await request(buildApp()).post(`/api/request-forms/submissions/${SUB_Q}/reject`).send({});
    expect(res.status).toBe(403);
    expect(tx().ticket.update).not.toHaveBeenCalled();
  });

  it("is refused once the submission is no longer PENDING", async () => {
    submissions[0].status = "ACCEPTED";
    const res = await request(buildApp()).post(`/api/request-forms/submissions/${SUB_P}/reject`).send({});
    expect(res.status).toBe(409);
    expect(tx().ticket.update).not.toHaveBeenCalled();
  });

  it("still rejects a PENDING submission in scope, soft-deleting its ticket", async () => {
    const res = await request(buildApp()).post(`/api/request-forms/submissions/${SUB_P}/reject`).send({});
    expect(res.status).toBe(200);
    expect(tx().ticket.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t-p" }, data: { deletedAt: expect.any(Date) } }));
  });
});

describe("accepting a submission", () => {
  it("clears the review flag on the ticket as well as on the submission", async () => {
    const res = await request(buildApp()).post(`/api/request-forms/submissions/${SUB_P}/accept`).send({});
    expect(res.status).toBe(200);
    expect(tx().ticket.update).toHaveBeenCalledWith({ where: { id: "t-p" }, data: { needsReview: false } });
  });

  it("is refused outside the caller's project scope", async () => {
    const res = await request(buildApp()).post(`/api/request-forms/submissions/${SUB_Q}/accept`).send({});
    expect(res.status).toBe(403);
  });
});

describe("a form cannot file its tickets as CHANGE", () => {
  it("refuses ticketType CHANGE", async () => {
    actor.role = "ADMIN";
    actor.permissions = [permissions.FORMS_CONFIGURE];
    const res = await request(buildApp())
      .post("/api/request-forms")
      .send({
        name: "Change intake",
        slug: "change-intake",
        projectId: "33333333-3333-4333-8333-333333333333",
        ticketType: "CHANGE",
        schema: { fields: [{ key: "title", label: "Title", type: "TEXT", mapsTo: "title", required: true }] }
      });
    expect(res.status).toBe(422);
    expect(client.requestForm.create).not.toHaveBeenCalled();
  });
});
