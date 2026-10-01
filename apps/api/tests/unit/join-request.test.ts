/**
 * Join requests (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.3): a person whose company already
 * has this workspace asks to join it; somebody who may create users decides.
 *
 * Pinned, because each is a way a stranger ends up with the wrong access or a workspace pays for a
 * seat twice:
 *  - one pending request per address; a member is told they are a member, and nothing is created;
 *  - approval respects the plan's seat limit and refuses while the workspace is not ACTIVE;
 *  - approving someone who became a member meanwhile LINKS them — no second account, no second seat;
 *  - approval creates an EMPLOYEE by default with no usable password and mails a 72-hour link;
 *  - only a super admin may grant more than EMPLOYEE;
 *  - a request past its expiry is EXPIRED and cannot be approved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Req = {
  id: string;
  email: string;
  name: string;
  message: string | null;
  status: string;
  expiresAt: Date;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  roleGranted: string | null;
  createdUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type User = { id: string; email: string; name: string; status: string; deletedAt: Date | null; roleName: string };

const requests = new Map<string, Req>();
const users = new Map<string, User>();
let seq = 0;

const matches = (row: Req, where: Record<string, unknown>) =>
  Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const cond = value as { gt?: Date; lte?: Date; in?: string[] };
      const field = row[key as keyof Req] as Date | string;
      if (cond.gt) return (field as Date) > cond.gt;
      if (cond.lte) return (field as Date) <= cond.lte;
      if (cond.in) return cond.in.includes(field as string);
    }
    return row[key as keyof Req] === value;
  });

const tenant = {
  user: {
    findUnique: vi.fn(async ({ where }: { where: { email: string } }) => [...users.values()].find((u) => u.email === where.email) ?? null),
    findMany: vi.fn(async () => [...users.values()].filter((u) => u.roleName === "SUPER_ADMIN" && u.status === "ACTIVE").map((u) => ({ id: u.id, email: u.email, name: u.name }))),
    create: vi.fn(async ({ data }: { data: { email: string; name: string; status: string } }) => {
      seq += 1;
      const user = { id: `user-${seq}`, email: data.email, name: data.name, status: data.status, deletedAt: null, roleName: "EMPLOYEE" };
      users.set(user.id, user);
      return { ...user, ...data };
    })
  },
  role: { findUniqueOrThrow: vi.fn(async ({ where }: { where: { name: string } }) => ({ id: `role-${where.name}`, name: where.name })) },
  userRole: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
  joinRequest: {
    create: vi.fn(async ({ data }: { data: Partial<Req> }) => {
      seq += 1;
      const row: Req = {
        id: `jr-${seq}`,
        message: null,
        status: "PENDING",
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
        roleGranted: null,
        createdUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(data as Req)
      };
      requests.set(row.id, row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...requests.values()].find((r) => matches(r, where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => requests.get(where.id) ?? null),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...requests.values()].filter((r) => matches(r, where))),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...requests.values()].filter((r) => matches(r, where)).length),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Req> }) => {
      const row = { ...requests.get(where.id)!, ...data, updatedAt: new Date() };
      requests.set(where.id, row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Req> }) => {
      let count = 0;
      for (const row of requests.values()) {
        if (matches(row, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    })
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tenant))
};
vi.mock("../../src/config/prisma.js", () => ({ prisma: tenant }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));

let orgStatus = "ACTIVE";
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { organization: { findUnique: vi.fn(async () => ({ id: "org-1", name: "Acme", status: orgStatus })) } }
}));

const dispatchInAppToMany = vi.fn(async () => 1);
const dispatchTransactional = vi.fn(async () => ({ ok: true }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchInAppToMany, dispatchTransactional }));
const audit = vi.fn(async () => undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit }));
let seatLimit = 10;
let activeSeats = 3;
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: vi.fn(async () => seatLimit) }));
vi.mock("../../src/services/seat-count.service.js", () => ({ countActiveSeats: vi.fn(async () => activeSeats) }));
const syncSubscriptionSeats = vi.fn(async () => undefined);
vi.mock("../../src/services/billing-sync.service.js", () => ({ syncSubscriptionSeats }));
const rememberWorkspaceMembership = vi.fn(async () => undefined);
vi.mock("../../src/services/workspace-directory.service.js", () => ({ rememberWorkspaceMembership, tenantBaseUrl: () => "https://acme.timesphere.test" }));
const issueSetPasswordLink = vi.fn(async () => "https://acme.timesphere.test/reset-password?token=t&welcome=1");
vi.mock("../../src/services/set-password-link.service.js", () => ({ issueSetPasswordLink }));

const { approveJoinRequest, createJoinRequest, declineJoinRequest, listJoinRequests } = await import("../../src/services/join-request.service.js");

const now = new Date("2026-10-01T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const superAdmin = { id: "sa-1", role: "SUPER_ADMIN" };
const admin = { id: "ad-1", role: "ADMIN" };
const ask = (email = "sam@acme.com") => createJoinRequest({ email, name: "Sam", message: "I'm on the platform team.", ttlDays: 14, workspaceName: "Acme", now });

beforeEach(() => {
  requests.clear();
  users.clear();
  seq = 0;
  orgStatus = "ACTIVE";
  seatLimit = 10;
  activeSeats = 3;
  vi.clearAllMocks();
  users.set("sa-1", { id: "sa-1", email: "boss@acme.com", name: "Boss", status: "ACTIVE", deletedAt: null, roleName: "SUPER_ADMIN" });
});

describe("asking to join", () => {
  it("creates one pending request that expires after the configured days, and tells the super admins", async () => {
    const result = await ask();
    expect(result.status).toBe("requested");
    const row = requests.get(result.id!)!;
    expect(row).toMatchObject({ email: "sam@acme.com", status: "PENDING" });
    expect(row.expiresAt.getTime()).toBe(now.getTime() + 14 * DAY);
    expect(dispatchInAppToMany).toHaveBeenCalledWith(expect.objectContaining({ userIds: ["sa-1"], category: "join.requested", link: "/app/users?tab=requests" }));
    expect(dispatchTransactional).toHaveBeenCalledWith(expect.objectContaining({ to: "boss@acme.com", templateKey: "workspace.join_request" }));
  });

  it("returns already_pending for a second ask — one request per address", async () => {
    await ask();
    expect((await ask("SAM@acme.com")).status).toBe("already_pending");
    expect(requests.size).toBe(1);
  });

  it("answers member, and creates nothing, when the address already has an account", async () => {
    users.set("u-9", { id: "u-9", email: "sam@acme.com", name: "Sam", status: "ACTIVE", deletedAt: null, roleName: "EMPLOYEE" });
    expect((await ask()).status).toBe("member");
    expect(requests.size).toBe(0);
  });
});

describe("approving", () => {
  it("creates an EMPLOYEE by default with no usable password, and mails a 72-hour set-password link", async () => {
    const { id } = await ask();
    const result = await approveJoinRequest(id!, admin, { orgId: "org-1", now });
    expect(result.linked).toBe(false);
    expect(tenant.role.findUniqueOrThrow).toHaveBeenCalledWith({ where: { name: "EMPLOYEE" } });
    const created = tenant.user.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(created).toMatchObject({ email: "sam@acme.com", name: "Sam", status: "ACTIVE", mustChangePassword: false });
    expect(String(created.passwordHash)).toMatch(/^\$2[aby]\$/);
    expect(issueSetPasswordLink).toHaveBeenCalledWith(result.userId, 72 * 60 * 60 * 1000);
    expect(dispatchTransactional).toHaveBeenCalledWith(
      expect.objectContaining({ to: "sam@acme.com", templateKey: "workspace.join_approved", vars: expect.objectContaining({ actionUrl: expect.stringContaining("welcome=1") }) })
    );
    expect(requests.get(id!)).toMatchObject({ status: "APPROVED", decidedById: "ad-1", roleGranted: "EMPLOYEE", createdUserId: result.userId });
    expect(syncSubscriptionSeats).toHaveBeenCalledWith("org-1");
    expect(rememberWorkspaceMembership).toHaveBeenCalledWith("org-1", "sam@acme.com");
  });

  it("refuses at the seat limit with a 402 the admin can act on", async () => {
    const { id } = await ask();
    activeSeats = 10;
    await expect(approveJoinRequest(id!, admin, { orgId: "org-1", now })).rejects.toMatchObject({ statusCode: 402 });
    expect(tenant.user.create).not.toHaveBeenCalled();
    expect(requests.get(id!)?.status).toBe("PENDING");
  });

  it("refuses while the workspace is not ACTIVE", async () => {
    const { id } = await ask();
    orgStatus = "GRACE";
    await expect(approveJoinRequest(id!, superAdmin, { orgId: "org-1", now })).rejects.toMatchObject({ statusCode: 409, code: "WORKSPACE_UNAVAILABLE" });
    expect(tenant.user.create).not.toHaveBeenCalled();
  });

  it("links someone who became a member meanwhile — no second account, no second seat", async () => {
    const { id } = await ask();
    users.set("u-9", { id: "u-9", email: "sam@acme.com", name: "Sam", status: "ACTIVE", deletedAt: null, roleName: "EMPLOYEE" });
    activeSeats = 10; // full — and it does not matter, because no seat is added
    const result = await approveJoinRequest(id!, admin, { orgId: "org-1", now });
    expect(result).toEqual({ userId: "u-9", linked: true });
    expect(tenant.user.create).not.toHaveBeenCalled();
    expect(syncSubscriptionSeats).not.toHaveBeenCalled();
    expect(requests.get(id!)).toMatchObject({ status: "APPROVED", createdUserId: "u-9" });
  });

  it("refuses to link an archived account — it must be restored deliberately, from Users", async () => {
    const { id } = await ask();
    users.set("u-9", { id: "u-9", email: "sam@acme.com", name: "Sam", status: "INACTIVE", deletedAt: new Date(), roleName: "EMPLOYEE" });
    await expect(approveJoinRequest(id!, admin, { orgId: "org-1", now })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("lets only a super admin grant a role above EMPLOYEE", async () => {
    const { id } = await ask();
    await expect(approveJoinRequest(id!, admin, { orgId: "org-1", role: "MANAGER", now })).rejects.toMatchObject({ statusCode: 403 });
    const result = await approveJoinRequest(id!, superAdmin, { orgId: "org-1", role: "MANAGER", now });
    expect(tenant.role.findUniqueOrThrow).toHaveBeenLastCalledWith({ where: { name: "MANAGER" } });
    expect(requests.get(id!)?.roleGranted).toBe("MANAGER");
    expect(result.linked).toBe(false);
  });

  it("refuses a request that has already been decided", async () => {
    const { id } = await ask();
    await declineJoinRequest(id!, "sa-1", undefined, now);
    await expect(approveJoinRequest(id!, superAdmin, { orgId: "org-1", now })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("expiry", () => {
  it("a pending request past its expiry reads as EXPIRED and cannot be approved", async () => {
    const { id } = await ask();
    const later = new Date(now.getTime() + 15 * DAY);
    const pending = await listJoinRequests("pending", later);
    expect(pending).toHaveLength(0);
    expect(requests.get(id!)?.status).toBe("EXPIRED");
    await expect(approveJoinRequest(id!, superAdmin, { orgId: "org-1", now: later })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("an expired request does not block asking again", async () => {
    await ask();
    const later = new Date(now.getTime() + 15 * DAY);
    const again = await createJoinRequest({ email: "sam@acme.com", name: "Sam", ttlDays: 14, workspaceName: "Acme", now: later });
    expect(again.status).toBe("requested");
  });
});

describe("declining", () => {
  it("records who, when and why, and mails the requester", async () => {
    const { id } = await ask();
    await declineJoinRequest(id!, "sa-1", "Please use your client's workspace instead.", now);
    expect(requests.get(id!)).toMatchObject({ status: "DECLINED", decidedById: "sa-1", decisionNote: "Please use your client's workspace instead." });
    expect(dispatchTransactional).toHaveBeenCalledWith(
      expect.objectContaining({ to: "sam@acme.com", templateKey: "workspace.join_declined", vars: expect.objectContaining({ note: "Please use your client's workspace instead." }) })
    );
    expect(audit).toHaveBeenCalledWith("sa-1", "join_request.declined", "JoinRequest", id, expect.anything());
  });
});
