/**
 * Users → Requests, driven through the real router: what the ROUTE alone is responsible for.
 *
 * 1. ONLY SOMEONE WHO MAY CREATE USERS DECIDES. Approving a request creates an account, so the gate
 *    is the user-create gate (`users:manage`), not "any signed-in member".
 * 2. THE ROLE AND THE WORKSPACE COME FROM THE RIGHT PLACES. The role is the closed RoleName set off
 *    the body; the workspace id is the tenant context's, never something a request can name.
 * 3. THE FILTER IS A CLOSED SET — anything but pending/decided is refused before a query runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let actor = { id: "ad-1", name: "Admin", email: "a@acme.com", role: "ADMIN", permissions: ["users:manage"] };

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    }
  };
});
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));

const listJoinRequests = vi.fn(async () => [{ id: "jr-1" }]);
const approveJoinRequest = vi.fn(async () => ({ userId: "u-1", linked: false }));
const declineJoinRequest = vi.fn(async () => undefined);
vi.mock("../../src/services/join-request.service.js", () => ({ listJoinRequests, approveJoinRequest, declineJoinRequest }));

const { joinRequestRouter } = await import("../../src/controllers/join-request.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/join-requests", joinRequestRouter);
  a.use(errorHandler);
  return a;
};

beforeEach(() => {
  vi.clearAllMocks();
  actor = { id: "ad-1", name: "Admin", email: "a@acme.com", role: "ADMIN", permissions: ["users:manage"] };
});

describe("join-request routes", () => {
  it("refuses someone who may not create users", async () => {
    actor = { ...actor, role: "EMPLOYEE", permissions: [] };
    expect((await request(app()).get("/api/join-requests?filter=pending")).status).toBe(403);
    expect((await request(app()).post("/api/join-requests/jr-1/approve").send({})).status).toBe(403);
    expect(approveJoinRequest).not.toHaveBeenCalled();
  });

  it("lists by a closed filter, defaulting to pending", async () => {
    expect((await request(app()).get("/api/join-requests")).status).toBe(200);
    expect(listJoinRequests).toHaveBeenLastCalledWith("pending");
    expect((await request(app()).get("/api/join-requests?filter=decided")).status).toBe(200);
    expect(listJoinRequests).toHaveBeenLastCalledWith("decided");
    expect((await request(app()).get("/api/join-requests?filter=everything")).status).toBe(422);
  });

  it("approves with the actor, the chosen role, and the TENANT's workspace id", async () => {
    const res = await request(app()).post("/api/join-requests/jr-1/approve").send({ role: "MANAGER", orgId: "someone-elses-org" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: "u-1", linked: false });
    expect(approveJoinRequest).toHaveBeenCalledWith("jr-1", { id: "ad-1", role: "ADMIN" }, { orgId: "org-1", role: "MANAGER" });
  });

  it("refuses a role that is not a role", async () => {
    expect((await request(app()).post("/api/join-requests/jr-1/approve").send({ role: "OWNER" })).status).toBe(422);
    expect(approveJoinRequest).not.toHaveBeenCalled();
  });

  it("declines with an optional note, capped at the column's length", async () => {
    expect((await request(app()).post("/api/join-requests/jr-1/decline").send({ note: "Use the client workspace." })).status).toBe(204);
    expect(declineJoinRequest).toHaveBeenCalledWith("jr-1", "ad-1", "Use the client workspace.");
    expect((await request(app()).post("/api/join-requests/jr-1/decline").send({ note: "x".repeat(501) })).status).toBe(422);
  });
});
