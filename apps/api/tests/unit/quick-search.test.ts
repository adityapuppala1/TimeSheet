/**
 * The command palette's record search. What matters is not that it finds things but what it
 * REFUSES to find: it must read through the same project scope every ticket route enforces, or
 * it is a data leak with an autocomplete. Plus the two rules a person can feel — a key prefix
 * wins, and nothing is searched under two characters.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "user-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [permissions.TICKETS_VIEW] as string[] };

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

const { searchRouter } = await import("../../src/controllers/search.controller.js");
const { rankTickets } = await import("../../src/services/search.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/search", searchRouter);
  app.use(errorHandler);
  return app;
}

const TICKET = { id: "t1", key: "WEB-12", title: "Login loop", status: "OPEN", project: { name: "Web" } };

beforeEach(() => {
  actor.role = "EMPLOYEE";
  actor.permissions = [permissions.TICKETS_VIEW];
  client = {
    ticket: { findMany: vi.fn().mockResolvedValue([TICKET]) },
    project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", code: "WEB", name: "Web" }]) },
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "p1" }]) },
    user: { findMany: vi.fn().mockResolvedValue([]) }
  } as unknown as PrismaClient;
});

const ticketWhere = () => (vi.mocked(client.ticket.findMany).mock.calls[0][0] as any).where;
const projectWhere = () => (vi.mocked(client.project.findMany).mock.calls[0][0] as any).where;

describe("scope", () => {
  it("an EMPLOYEE searches only inside their assigned projects — both groups", async () => {
    const res = await request(buildApp()).get("/api/search?q=web");
    expect(res.status).toBe(200);
    expect(ticketWhere().projectId).toEqual({ in: ["p1"] });
    expect(projectWhere().id).toEqual({ in: ["p1"] });
    expect(res.body.tickets[0]).toMatchObject({ key: "WEB-12", projectName: "Web" });
  });

  it("no assignments means an EMPTY in-list, never an open one", async () => {
    // `in: []` is the false predicate; dropping the clause would be the leak.
    vi.mocked(client.userProjectAssignment.findMany).mockResolvedValue([] as never);
    await request(buildApp()).get("/api/search?q=web");
    expect(ticketWhere().projectId).toEqual({ in: [] });
    expect(projectWhere().id).toEqual({ in: [] });
  });

  it("an ADMIN is unrestricted", async () => {
    actor.role = "ADMIN";
    await request(buildApp()).get("/api/search?q=web");
    expect("projectId" in ticketWhere()).toBe(false);
    expect("id" in projectWhere()).toBe(false);
  });

  it("without tickets:view the ticket group is not even queried", async () => {
    actor.permissions = [];
    const res = await request(buildApp()).get("/api/search?q=web");
    expect(res.body.tickets).toEqual([]);
    expect(client.ticket.findMany).not.toHaveBeenCalled();
    expect(client.project.findMany).toHaveBeenCalled();
  });
});

describe("the two rules a person can feel", () => {
  it("asks nothing under two characters", async () => {
    const res = await request(buildApp()).get("/api/search?q=w");
    expect(res.body).toEqual({ tickets: [], projects: [], people: [] });
    expect(client.ticket.findMany).not.toHaveBeenCalled();
    expect(client.project.findMany).not.toHaveBeenCalled();
  });

  it("ranks a key prefix above a title match, preserving order within each", () => {
    const rows = [
      { key: "API-3", title: "web-1 regression" },
      { key: "WEB-10", title: "Old" },
      { key: "WEB-1", title: "Older" }
    ];
    expect(rankTickets("web-1", rows).map((r) => r.key)).toEqual(["WEB-10", "WEB-1", "API-3"]);
  });
});

/* V12 6.2 — the people group exists only for callers who can open the page it links to. */
describe("people", () => {
  it("is empty — not queried — without users:manage, and never a 403", async () => {
    const res = await request(buildApp()).get("/api/search?q=an");
    expect(res.status).toBe(200);
    expect(res.body.people).toEqual([]);
    expect(client.user.findMany).not.toHaveBeenCalled();
  });

  it("returns active, non-agent people by name or email prefix for a user manager", async () => {
    actor.permissions = [permissions.TICKETS_VIEW, permissions.USERS_MANAGE];
    vi.mocked(client.user.findMany).mockResolvedValue([{ id: "u1", name: "Ana Reyes", email: "ana@x.io" }] as never);
    const res = await request(buildApp()).get("/api/search?q=an");
    expect(res.status).toBe(200);
    expect(res.body.people).toEqual([{ id: "u1", name: "Ana Reyes", email: "ana@x.io" }]);
    const where = (vi.mocked(client.user.findMany).mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ deletedAt: null, status: "ACTIVE", isAgent: false });
  });
});
