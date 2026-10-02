/**
 * Every account holds a `UserRole` row for its own primary role — written where the account is
 * created, not only by the one-off backfill in migration 20260826120000_user_multi_role.
 *
 * WHY IT MATTERS: that backfill ran once. Every account created afterwards by a path that skipped
 * the row — the founder in prisma/seed.ts, the CSV import, SCIM — was invisible to anything that
 * reads `UserRole`: the last-super-admin guard (fixed separately to count primary roles too) and
 * `/auth/switch-role`, which only lets you switch into a role you hold a row for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";
import { createUserDirectoryFake, fakeUser } from "../helpers/fake-user-directory.js";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "founder", role: "SUPER_ADMIN", name: "F", email: "f@x.io", permissions: ["users:manage"] } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/maintenance.service.js", () => ({ getOnlineSeenByUser: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: vi.fn().mockResolvedValue(100) }));
vi.mock("../../src/services/billing-sync.service.js", () => ({ syncSubscriptionSeats: vi.fn().mockResolvedValue(undefined) }));

const { userRouter } = await import("../../src/controllers/user.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let fake: ReturnType<typeof createUserDirectoryFake>;

beforeEach(() => {
  fake = createUserDirectoryFake([fakeUser({ id: "founder", roleName: "SUPER_ADMIN", userRoleNames: [] })]);
});

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => runInTenant(fake.client, async () => next(), "org-1").catch(next));
  server.use("/api/users", userRouter);
  server.use(errorHandler);
  return request(server);
}

describe("CSV import", () => {
  it("gives every imported account a UserRole row for the role it was created with", async () => {
    const res = await app()
      .post("/api/users/bulk")
      .send({
        rows: [
          { name: "Manager Person", email: "mgr@x.io", role: "MANAGER" },
          { name: "Employee Person", email: "emp@x.io", role: "EMPLOYEE" }
        ]
      });
    expect(res.status).toBe(201);
    expect(fake.users.find((u) => u.email === "mgr@x.io")!.userRoleNames).toEqual(["MANAGER"]);
    expect(fake.users.find((u) => u.email === "emp@x.io")!.userRoleNames).toEqual(["EMPLOYEE"]);
  });
});

describe("prisma/seed.ts", () => {
  /** Any model, any method: resolves to a row with an id, or no rows for reads. Enough for the seed
   *  to run end to end without a database, while recording what it wrote. */
  function recordingClient(users: Array<{ id: string; roleId: string }>) {
    const calls: Record<string, unknown[]> = {};
    const model = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, method: string) =>
            vi.fn(async (args?: { where?: { name?: string } }) => {
              (calls[`${name}.${method}`] ??= []).push(args);
              if (name === "user" && method === "findMany") return users;
              if (method === "findMany") return [];
              if (method === "count") return 0;
              if (method.endsWith("Many")) return { count: 0 };
              return { id: `${name}-${args?.where?.name ?? "row"}` };
            })
        }
      );
    const client = new Proxy({}, { get: (_target, name: string) => (name.startsWith("$") ? vi.fn() : model(name)) });
    return { client: client as unknown as PrismaClient, calls };
  }

  it("writes the founder's UserRole row — every account's own role, the way the backfill did", async () => {
    const { seedTenant } = await import("../../prisma/seed.js");
    const people = [
      { id: "founder-id", roleId: "role-SUPER_ADMIN" },
      { id: "intake-id", roleId: "role-EMPLOYEE" }
    ];
    const { client, calls } = recordingClient(people);

    await seedTenant(client, { adminEmail: "owner@acme.test", adminName: "Owner", adminPassword: "Owner@12345", includeDemoData: false } as never);

    // skipDuplicates is the seed's INSERT IGNORE: a re-seed of an existing workspace adds nothing.
    expect(calls["userRole.createMany"]).toEqual([
      { data: people.map((p) => ({ userId: p.id, roleId: p.roleId })), skipDuplicates: true }
    ]);
  });
});

describe("migration 20261002121000_user_role_backfill", () => {
  /** Lower-cased, `--` comments stripped (they quote the very SQL being described). Read lazily so
   *  a missing file fails these two tests by name rather than the whole suite at collection. */
  const code = () =>
    readFileSync(fileURLToPath(new URL("../../prisma/migrations/20261002121000_user_role_backfill/migration.sql", import.meta.url)), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .toLowerCase();

  it("backfills each account's primary role exactly as the multi-role migration did", () => {
    expect(code()).toMatch(/insert\s+ignore\s+into\s+`userrole`\s*\(\s*`id`\s*,\s*`userid`\s*,\s*`roleid`\s*\)\s*select\s+uuid\(\)\s*,\s*`id`\s*,\s*`roleid`\s+from\s+`user`/);
  });

  it("is data-only — no table, column or index changes", () => {
    expect(code()).not.toMatch(/\b(create|alter|drop)\s+(table|index)\b/);
  });
});
