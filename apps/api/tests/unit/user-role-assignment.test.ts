/**
 * Multi-role accounts: granting more than one role is SUPER_ADMIN-only, from User Management's
 * create/edit routes (user.controller.ts). ADMIN keeps every capability it already had — including
 * changing someone's single active role exactly as before — it just cannot touch the new `roles`
 * array. A separate guard refuses any change that would leave zero active accounts holding
 * SUPER_ADMIN, since — unlike a role switch, always reversible — that lockout is not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

let actorRole: "SUPER_ADMIN" | "ADMIN" = "SUPER_ADMIN";
// Controls the two userRole.count queries wouldLockOutSuperAdmin makes — see the mock below.
let targetHoldsSuperAdmin = false;
let otherSuperAdminHolders = 1;
const ACTOR_ID = "actor-1";
const TARGET = "target-1";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: ACTOR_ID, name: "Actor", email: "actor@x.io", role: actorRole, permissions: ["users:manage"] } as never;
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

const { userRouter } = await import("../../src/controllers/user.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/users", userRouter);
  app.use(errorHandler);
  return app;
}

const ROLE_IDS: Record<string, string> = { SUPER_ADMIN: "role-sa", ADMIN: "role-admin", MANAGER: "role-mgr", EMPLOYEE: "role-emp" };

beforeEach(() => {
  actorRole = "SUPER_ADMIN";
  targetHoldsSuperAdmin = false;
  otherSuperAdminHolders = 1;
  client = {
    user: {
      findUnique: vi.fn().mockResolvedValue(null), // no email collision on create
      create: vi.fn().mockResolvedValue({ id: TARGET, name: "New", email: "new@x.io" }),
      update: vi.fn().mockResolvedValue({ id: TARGET, role: { name: "MANAGER" } }),
      count: vi.fn().mockResolvedValue(3)
    },
    role: {
      findUniqueOrThrow: vi.fn((args: any) => Promise.resolve({ id: ROLE_IDS[args.where.name], name: args.where.name })),
      findMany: vi.fn((args: any) => {
        const names: string[] = args?.where?.name?.in ?? [];
        return Promise.resolve(names.map((name) => ({ id: ROLE_IDS[name] })));
      })
    },
    userRole: {
      // Two distinct queries share this mock: "does the target hold role X" (a plain `userId`
      // match) and "how many OTHER active accounts hold role X" (`userId: { not: ... }`). Default:
      // the target doesn't hold it and nobody else does either — tests override per scenario.
      count: vi.fn((args: any) => Promise.resolve(typeof args?.where?.userId === "object" ? otherSuperAdminHolders : targetHoldsSuperAdmin ? 1 : 0)),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 })
    }
  } as unknown as PrismaClient;
});

describe("POST /users — granting multiple roles", () => {
  const create = (body: Record<string, unknown>) =>
    request(buildApp())
      .post("/api/users")
      .send({ name: "New Person", email: "new@x.io", role: "MANAGER", ...body });

  it("an ADMIN creating a user without `roles` is unaffected — one UserRole row for the single role", async () => {
    actorRole = "ADMIN";
    const res = await create({});
    expect(res.status).toBe(201);
    expect(client.userRole.createMany).toHaveBeenCalledWith({ data: [{ userId: TARGET, roleId: ROLE_IDS.MANAGER }] });
  });

  it("an ADMIN supplying `roles` is refused — only a super admin may grant more than one", async () => {
    actorRole = "ADMIN";
    const res = await create({ roles: ["MANAGER", "TEAM_LEAD"] });
    expect(res.status).toBe(403);
  });

  it("a SUPER_ADMIN supplying `roles` not containing the active `role` is refused", async () => {
    const res = await create({ role: "MANAGER", roles: ["TEAM_LEAD", "EMPLOYEE"] });
    expect(res.status).toBe(422);
  });

  it("a SUPER_ADMIN granting a real multi-role set succeeds and writes every UserRole row", async () => {
    const res = await create({ role: "MANAGER", roles: ["MANAGER", "SUPER_ADMIN"] });
    expect(res.status).toBe(201);
    const written = vi.mocked(client.userRole.createMany).mock.calls[0][0] as any;
    expect(written.data).toEqual(
      expect.arrayContaining([{ userId: TARGET, roleId: ROLE_IDS.MANAGER }, { userId: TARGET, roleId: ROLE_IDS.SUPER_ADMIN }])
    );
  });
});

describe("PATCH /users/:id — granting/changing roles", () => {
  /** `extraHeldRoleNames` models a target who already holds MORE than one role (only reachable
   *  by a prior SUPER_ADMIN grant) — omit it for the common single-held-role case. */
  function mockTarget(roleName: string, extraHeldRoleNames: string[] = []) {
    vi.mocked(client.user.findUnique).mockResolvedValue({
      role: { name: roleName },
      userRoles: extraHeldRoleNames.map((name) => ({ role: { name } }))
    } as never);
  }

  const patch = (body: Record<string, unknown>) => request(buildApp()).patch(`/api/users/${TARGET}`).send(body);

  it("an ADMIN changing just the active `role` still works exactly as before", async () => {
    actorRole = "ADMIN";
    mockTarget("EMPLOYEE");
    const res = await patch({ role: "TEAM_LEAD" });
    expect(res.status).toBe(200);
  });

  it("an ADMIN supplying `roles` is refused", async () => {
    actorRole = "ADMIN";
    mockTarget("EMPLOYEE");
    const res = await patch({ role: "MANAGER", roles: ["MANAGER", "TEAM_LEAD"] });
    expect(res.status).toBe(403);
  });

  it("an ADMIN acting on an existing SUPER_ADMIN's plain `role` field is refused (the adjacent gap fix)", async () => {
    actorRole = "ADMIN";
    mockTarget("SUPER_ADMIN");
    const res = await patch({ role: "EMPLOYEE" });
    expect(res.status).toBe(403);
  });

  it("a SUPER_ADMIN demoting the LAST super admin is refused — the lockout guard", async () => {
    mockTarget("SUPER_ADMIN");
    targetHoldsSuperAdmin = true;
    otherSuperAdminHolders = 0; // nobody else holds it
    const res = await patch({ role: "EMPLOYEE" });
    expect(res.status).toBe(422);
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("a SUPER_ADMIN demoting a super admin is allowed when another active account still holds it", async () => {
    mockTarget("SUPER_ADMIN");
    targetHoldsSuperAdmin = true;
    otherSuperAdminHolders = 1; // someone else holds it
    const res = await patch({ role: "EMPLOYEE" });
    expect(res.status).toBe(200);
  });

  it("an unrelated role change is never blocked just because some OTHER account is the sole super admin", async () => {
    // Regression pin: wouldLockOutSuperAdmin must check whether THIS target holds SUPER_ADMIN
    // before ever looking at "how many other accounts hold it" — an EMPLOYEE-to-TEAM_LEAD change
    // has nothing to do with who else in the org happens to be the only super admin.
    mockTarget("EMPLOYEE");
    targetHoldsSuperAdmin = false;
    otherSuperAdminHolders = 0;
    const res = await patch({ role: "TEAM_LEAD" });
    expect(res.status).toBe(200);
  });

  it("a SUPER_ADMIN replacing `roles` writes exactly that set (full replace, not additive)", async () => {
    mockTarget("MANAGER");
    const res = await patch({ role: "MANAGER", roles: ["MANAGER"] });
    expect(res.status).toBe(200);
    expect(client.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: TARGET } });
    expect(client.userRole.createMany).toHaveBeenCalledWith({ data: [{ userId: TARGET, roleId: ROLE_IDS.MANAGER }] });
  });

  it("`roles` without an active `role` is refused", async () => {
    mockTarget("MANAGER");
    const res = await patch({ roles: ["MANAGER", "TEAM_LEAD"] });
    expect(res.status).toBe(422);
  });

  it("the plain `role` field on a genuinely multi-role account only switches the active one — held set untouched", async () => {
    // Target already holds MANAGER (active) + TEAM_LEAD (via a prior SUPER_ADMIN grant). An ADMIN
    // using the plain field to switch their active role to one they ALREADY hold must not touch
    // the held-role set at all — no back door to grant/revoke a role without the `roles` array.
    actorRole = "ADMIN";
    mockTarget("MANAGER", ["TEAM_LEAD"]);
    const res = await patch({ role: "TEAM_LEAD" });
    expect(res.status).toBe(200);
    expect(client.userRole.deleteMany).not.toHaveBeenCalled();
    expect(client.userRole.createMany).not.toHaveBeenCalled();
  });

  it("the plain `role` field cannot grant a NEW role onto a multi-role account — that needs `roles`", async () => {
    actorRole = "ADMIN";
    mockTarget("MANAGER", ["TEAM_LEAD"]);
    const res = await patch({ role: "EMPLOYEE" }); // not already held
    expect(res.status).toBe(422);
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("a PATCH that touches neither `role` nor `roles` never writes UserRole at all", async () => {
    mockTarget("MANAGER");
    const res = await patch({ designation: "Staff Engineer" });
    expect(res.status).toBe(200);
    expect(client.userRole.deleteMany).not.toHaveBeenCalled();
    expect(client.userRole.createMany).not.toHaveBeenCalled();
  });
});
