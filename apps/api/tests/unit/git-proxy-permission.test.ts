/**
 * `/settings/git/repos|branches|pulls` proxy GitHub's API with the ORG'S decrypted OAuth token,
 * so their response is the connected account's PRIVATE repo, branch and pull-request inventory.
 * Every other `/settings/git/*` route is super-admin; these three were `requireAuth` only, which
 * made that inventory readable by anything holding a session.
 *
 * They are not super-admin either, because their real consumer is the ticket Dev tab's "Pick from
 * GitHub" picker — so the gate is TICKETS_WRITE, the permission that consumer already needs to
 * write the `TicketBranch` it produces.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { permissions } from "@timesheet/shared";
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
vi.mock("../../src/utils/encryption.js", () => ({
  decryptSecret: vi.fn(() => "gho_the_orgs_real_token"),
  encryptSecret: vi.fn((v: string) => v)
}));
vi.mock("../../src/services/git-provider.service.js", () => ({
  buildGitHubAuthorizeUrl: vi.fn(),
  signGitConnectState: vi.fn(),
  listGitHubRepos: vi.fn(async () => [{ fullName: "acme/secret-product", private: true }]),
  listGitHubBranches: vi.fn(async () => ["main", "release/unannounced"]),
  listGitHubPullRequests: vi.fn(async () => [{ number: 7, title: "Fix the unannounced thing" }])
}));

const { settingsRouter } = await import("../../src/controllers/settings.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const gitProvider = await import("../../src/services/git-provider.service.js");

let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/settings", settingsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "EMPLOYEE";
  actor.permissions = [];
  client = {
    gitConnection: { findUnique: vi.fn().mockResolvedValue({ id: "global", encryptedAccessToken: "cipher" }) }
  } as unknown as PrismaClient;
});

describe("GET /settings/git/* — the GitHub proxy routes", () => {
  it("does not hand the org's private repo list to a session without TICKETS_WRITE", async () => {
    const response = await request(buildApp()).get("/api/settings/git/repos");
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("acme/secret-product");
  });

  it("does not proxy branches or pull requests either", async () => {
    const app = buildApp();
    expect((await request(app).get("/api/settings/git/branches?repo=acme/secret-product")).status).toBe(403);
    expect((await request(app).get("/api/settings/git/pulls?repo=acme/secret-product")).status).toBe(403);
  });

  it("never decrypts the access token for a caller it is going to refuse", async () => {
    await request(buildApp()).get("/api/settings/git/repos");
    expect(client.gitConnection.findUnique).not.toHaveBeenCalled();
    expect(gitProvider.listGitHubRepos).not.toHaveBeenCalled();
  });

  it("still works for the picker's real audience — a normal engineer with TICKETS_WRITE", async () => {
    actor.permissions = [permissions.TICKETS_WRITE];
    const app = buildApp();

    const repos = await request(app).get("/api/settings/git/repos");
    expect(repos.status).toBe(200);
    expect(repos.body[0].fullName).toBe("acme/secret-product");

    expect((await request(app).get("/api/settings/git/branches?repo=acme/secret-product")).status).toBe(200);
    expect((await request(app).get("/api/settings/git/pulls?repo=acme/secret-product")).status).toBe(200);
  });

  it("keeps the rest of /settings/git super-admin — the gate was loosened for three routes, not the section", async () => {
    actor.permissions = [permissions.TICKETS_WRITE];
    expect((await request(buildApp()).get("/api/settings/git")).status).toBe(403);
  });
});
