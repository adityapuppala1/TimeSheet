/**
 * `GET /api/projects/:id/assignments` returns names, EMAIL ADDRESSES and roles. The router only
 * applies `requireAuth`, and the handler had no predicate at all — so any authenticated user
 * could read the full member roster of any project id, including projects they aren't on, while
 * `GET /api/projects` right above it has scoped its list by `visibilityScope()` all along.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "user-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };

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

const { projectRouter } = await import("../../src/controllers/project.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const HIDDEN_PROJECT = "22222222-2222-4222-8222-222222222222";
const ROSTER = [
  { id: "a-1", projectId: HIDDEN_PROJECT, user: { id: "u9", name: "Someone", email: "someone@corp.example", avatarUrl: null, status: "ACTIVE", role: { name: "ADMIN" } } }
];

let client: PrismaClient;
let visibleToActor: boolean;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/projects", projectRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  actor.role = "EMPLOYEE";
  visibleToActor = false;
  client = {
    // Stands in for the scoping query: returns the row only when the handler actually asked for
    // it WITH the `assignments: { some: ... }` predicate, or when the caller is unrestricted.
    project: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
        visibleToActor || !("assignments" in args.where) ? { id: HIDDEN_PROJECT } : null
      )
    },
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue(ROSTER) },
    user: { findMany: vi.fn().mockResolvedValue([]) }
  } as unknown as PrismaClient;
});

describe("GET /projects/:id/assignments", () => {
  it("does not hand an EMPLOYEE the roster of a project they aren't assigned to", async () => {
    const response = await request(buildApp()).get(`/api/projects/${HIDDEN_PROJECT}/assignments`);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("someone@corp.example");
    expect(client.userProjectAssignment.findMany).not.toHaveBeenCalled();
  });

  it("still returns the roster of a project they ARE assigned to", async () => {
    visibleToActor = true;
    const response = await request(buildApp()).get(`/api/projects/${HIDDEN_PROJECT}/assignments`);
    expect(response.status).toBe(200);
    expect(response.body[0].user.email).toBe("someone@corp.example");
  });

  it("scopes with the predicate in the WHERE clause, not a fetch-then-check in JS", async () => {
    await request(buildApp()).get(`/api/projects/${HIDDEN_PROJECT}/assignments`);
    const where = vi.mocked(client.project.findFirst).mock.calls[0]![0]!.where as Record<string, unknown>;
    expect(where.id).toBe(HIDDEN_PROJECT);
    expect(where.assignments).toBeDefined();
  });

  it("an ADMIN stays unrestricted", async () => {
    actor.role = "ADMIN";
    const response = await request(buildApp()).get(`/api/projects/${HIDDEN_PROJECT}/assignments`);
    expect(response.status).toBe(200);
  });
});
