/**
 * The "find my workspace" index (control-plane OrgUserDirectory) learns about a person when they
 * are added, not only when they first sign in — and forgets them when they are deleted.
 *
 * THE DEFECT (billing/lifecycle audit 2026-10, finding 7, second half): the index was written on
 * sign-in, signup and join approval only. Someone an admin created by hand, by CSV, or through SCIM
 * could not find their workspace by email until after they had already found it and signed in —
 * which is the one moment they no longer need to.
 *
 * AND THE OTHER HALF: `forgetWorkspaceMembership` documents itself as "called when a user is
 * deleted" and had no caller, so a deleted person's address went on naming the workspace to
 * whoever owns that mailbox next.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { runInTenant } from "../helpers/tenant-context.js";
import { createUserDirectoryFake, fakeUser } from "../helpers/fake-user-directory.js";

const { rememberWorkspaceMembership, forgetWorkspaceMembership } = vi.hoisted(() => ({
  rememberWorkspaceMembership: vi.fn(),
  forgetWorkspaceMembership: vi.fn()
}));

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "boss", role: "SUPER_ADMIN", name: "Boss", email: "boss@x.io", permissions: ["users:manage"] } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/face.service.js", () => ({
  findCoveredUnenrolledUserIds: vi.fn().mockResolvedValue([]),
  notifyEnrollmentRequired: vi.fn().mockResolvedValue(0)
}));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/maintenance.service.js", () => ({ getOnlineSeenByUser: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: vi.fn().mockResolvedValue(100) }));
vi.mock("../../src/services/billing-sync.service.js", () => ({ syncSubscriptionSeats: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({
  rememberWorkspaceMembership,
  forgetWorkspaceMembership,
  tenantBaseUrl: () => "https://acme.timesphere.test"
}));

const { userRouter } = await import("../../src/controllers/user.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let fake: ReturnType<typeof createUserDirectoryFake>;

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => runInTenant(fake.client, async () => next(), "org-1").catch(next));
  server.use("/api/users", userRouter);
  server.use(errorHandler);
  return request(server);
}

beforeEach(() => {
  fake = createUserDirectoryFake([fakeUser({ id: "boss", roleName: "SUPER_ADMIN" }), fakeUser({ id: "leaver", email: "leaver@x.io" }), fakeUser({ id: "other", email: "other@x.io" })]);
  rememberWorkspaceMembership.mockReset().mockResolvedValue(undefined);
  forgetWorkspaceMembership.mockReset().mockResolvedValue(undefined);
});

describe("adding someone puts them in the workspace finder", () => {
  it("POST /users", async () => {
    await app().post("/api/users").send({ name: "New Person", email: "new@x.io", role: "EMPLOYEE" }).expect(201);
    expect(rememberWorkspaceMembership).toHaveBeenCalledWith("org-1", "new@x.io");
  });

  it("the CSV import, for every row it created and none it refused", async () => {
    await app()
      .post("/api/users/bulk")
      .send({
        rows: [
          { name: "One Person", email: "one@x.io", role: "EMPLOYEE" },
          { name: "Dup Person", email: "leaver@x.io", role: "EMPLOYEE" },
          { name: "Two Person", email: "two@x.io", role: "EMPLOYEE" }
        ]
      })
      .expect(201);
    expect(rememberWorkspaceMembership.mock.calls).toEqual([
      ["org-1", "one@x.io"],
      ["org-1", "two@x.io"]
    ]);
  });
});

describe("deleting someone takes them out of it", () => {
  it("DELETE /users/:id", async () => {
    await app().delete("/api/users/leaver").expect(204);
    expect(forgetWorkspaceMembership).toHaveBeenCalledWith("org-1", "leaver@x.io");
  });

  it("bulk DELETE, for each person actually deleted", async () => {
    await app().post("/api/users/bulk-action").send({ action: "DELETE", userIds: ["leaver", "other"] }).expect(200);
    expect(forgetWorkspaceMembership.mock.calls).toEqual([
      ["org-1", "leaver@x.io"],
      ["org-1", "other@x.io"]
    ]);
  });

  it("deactivating is not deleting — the address stays findable for when they come back", async () => {
    await app().patch("/api/users/leaver").send({ status: "INACTIVE" }).expect(200);
    expect(forgetWorkspaceMembership).not.toHaveBeenCalled();
  });
});
