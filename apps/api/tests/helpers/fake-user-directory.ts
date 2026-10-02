import { vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

/**
 * An in-memory stand-in for the tenant's User / Role / UserRole / Session tables, for the User
 * Management routes (user.controller.ts) and SCIM. Unlike the bare `vi.fn()` stubs in
 * fake-prisma-client.ts it EVALUATES the handful of `where` shapes those routes use — the
 * super-admin holder query, the seat count, id/email lookups — so a test can say "the founder holds
 * SUPER_ADMIN by their primary role only" and assert what the route does about it, rather than
 * scripting the return value of each query in the order the route happens to make them.
 *
 * Deliberately small: a `where` it does not understand throws, so a route that starts asking a new
 * question fails loudly here instead of being answered with something plausible.
 */
export const ROLE_IDS: Record<string, string> = {
  SUPER_ADMIN: "role-sa",
  ADMIN: "role-admin",
  MANAGER: "role-mgr",
  TEAM_LEAD: "role-tl",
  EMPLOYEE: "role-emp"
};
const ROLE_NAMES = Object.fromEntries(Object.entries(ROLE_IDS).map(([name, id]) => [id, name]));

export interface FakeUser {
  id: string;
  name: string;
  email: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION";
  deletedAt: Date | null;
  /** The primary (active) role — `User.roleId`. */
  roleName: string;
  /** `UserRole` rows. Empty models an account the backfill never reached (the founder). */
  userRoleNames: string[];
  managerId: string | null;
  isAgent: boolean;
  faceVerificationRequired: boolean;
  passwordHash?: string;
}

export function fakeUser(partial: Partial<FakeUser> & { id: string }): FakeUser {
  return {
    name: partial.id,
    email: `${partial.id}@x.io`,
    status: "ACTIVE",
    deletedAt: null,
    roleName: "EMPLOYEE",
    userRoleNames: [partial.roleName ?? "EMPLOYEE"],
    managerId: null,
    isAgent: false,
    faceVerificationRequired: false,
    ...partial
  };
}

function shape(user: FakeUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    deletedAt: user.deletedAt,
    roleId: ROLE_IDS[user.roleName],
    managerId: user.managerId,
    isAgent: user.isAgent,
    faceVerificationRequired: user.faceVerificationRequired,
    role: { name: user.roleName },
    userRoles: user.userRoleNames.map((name) => ({ role: { name } }))
  };
}

type Where = Record<string, any>;

function matches(user: FakeUser, where: Where): boolean {
  for (const [key, value] of Object.entries(where)) {
    switch (key) {
      case "id":
        if (typeof value === "string" ? user.id !== value : value?.in ? !value.in.includes(user.id) : value?.not ? user.id === value.not : false) return false;
        break;
      case "email":
        if (user.email !== value) return false;
        break;
      case "status":
        if (typeof value === "string" ? user.status !== value : value?.in ? !value.in.includes(user.status) : false) return false;
        break;
      case "deletedAt":
        if (value === null ? user.deletedAt !== null : false) return false;
        break;
      case "isAgent":
        if (user.isAgent !== value) return false;
        break;
      case "roleId":
        if (ROLE_IDS[user.roleName] !== value) return false;
        break;
      case "userRoles":
        if (!user.userRoleNames.some((name) => ROLE_IDS[name] === value.some.roleId)) return false;
        break;
      case "designation":
        break;
      case "OR":
        if (!(value as Where[]).some((branch) => matches(user, branch))) return false;
        break;
      default:
        throw new Error(`fake-user-directory: unsupported where key "${key}"`);
    }
  }
  return true;
}

export function createUserDirectoryFake(initial: FakeUser[]) {
  const users = initial.map((u) => ({ ...u, userRoleNames: [...u.userRoleNames] }));
  const byId = (id: string) => users.find((u) => u.id === id);
  let createdSeq = 0;

  const client = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: Where }) => {
        const found = users.find((u) => matches(u, where));
        return found ? shape(found) : null;
      }),
      findMany: vi.fn(async (args: { where?: Where } = {}) => users.filter((u) => matches(u, args.where ?? {})).map(shape)),
      count: vi.fn(async ({ where }: { where: Where }) => users.filter((u) => matches(u, where)).length),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const nested = data.userRoles?.create;
        const nestedRows = nested ? (Array.isArray(nested) ? nested : [nested]) : [];
        const created = fakeUser({
          id: `created-${++createdSeq}`,
          name: data.name,
          email: data.email,
          status: data.status ?? "ACTIVE",
          roleName: ROLE_NAMES[data.roleId],
          userRoleNames: nestedRows.map((row: { roleId: string }) => ROLE_NAMES[row.roleId]),
          managerId: data.managerId ?? null
        });
        users.push(created);
        return shape(created);
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const user = byId(where.id);
        if (!user) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        if (data.status) user.status = data.status;
        if ("deletedAt" in data) user.deletedAt = data.deletedAt;
        if (data.roleId) user.roleName = ROLE_NAMES[data.roleId];
        if ("managerId" in data) user.managerId = data.managerId;
        if (data.name) user.name = data.name;
        if (data.email) user.email = data.email;
        if (data.passwordHash) user.passwordHash = data.passwordHash;
        return shape(user);
      })
    },
    role: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { name: string } }) => {
        if (!ROLE_IDS[where.name]) throw new Error(`No role ${where.name}`);
        return { id: ROLE_IDS[where.name], name: where.name };
      }),
      findMany: vi.fn(async (args: { where?: { name?: { in: string[] } } } = {}) => {
        const names = args.where?.name?.in ?? Object.keys(ROLE_IDS);
        return names.map((name) => ({ id: ROLE_IDS[name], name }));
      })
    },
    userRole: {
      /** Rows only — `{ userId, roleId }`, or `{ roleId, userId: { not }, user: { status, deletedAt } }`. */
      count: vi.fn(async ({ where }: { where: Where }) =>
        users.filter((u) => {
          if (!u.userRoleNames.some((name) => ROLE_IDS[name] === where.roleId)) return false;
          if (typeof where.userId === "string") return u.id === where.userId;
          if (where.userId?.not && u.id === where.userId.not) return false;
          return where.user ? matches(u, where.user) : true;
        }).length
      ),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const user = byId(where.userId);
        const count = user?.userRoleNames.length ?? 0;
        if (user) user.userRoleNames = [];
        return { count };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<{ userId: string; roleId: string }> }) => {
        for (const row of data) {
          const user = byId(row.userId);
          const name = ROLE_NAMES[row.roleId];
          if (user && !user.userRoleNames.includes(name)) user.userRoleNames.push(name);
        }
        return { count: data.length };
      })
    },
    session: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(client) : Promise.all(arg as Promise<unknown>[])
    )
  };

  return { client: client as unknown as PrismaClient, users, byId, raw: client };
}
