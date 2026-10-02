import express from "express";
import { vi } from "vitest";
import { tenantContext } from "../../src/config/tenant-context.js";
import { errorHandler } from "../../src/middleware/error.js";

/**
 * A small, STATEFUL stand-in for the tenant database, shaped around one change request and its
 * ticket — enough for the change routes, the automation dispatcher and the proposal applier to run
 * for real against it.
 *
 * WHY STATEFUL rather than a bag of `vi.fn()`s: the defects these tests pin are about what a SECOND
 * request sees after a first one wrote something (a plan edited after submission, then decided; a
 * round opened by a workflow, then decided). Stubs that return a fixed row cannot show that.
 *
 * Used with `tenantContext.run({ client })`, exactly as production resolves a tenant — the real
 * `prisma` proxy forwards to whatever client is active, so nothing in config/prisma.ts is mocked.
 */
export const CHANGE_ID = "11111111-1111-4111-8111-111111111111";
export const TICKET_ID = "22222222-2222-4222-8222-222222222222";

export interface ApprovalRow {
  id: string;
  changeId: string;
  round: number;
  approverId: string;
  reason: string;
  status: string;
  comments: string | null;
  decidedAt: Date | null;
  dueAt: Date | null;
  createdAt: Date;
}

/** A NORMAL, HIGH-risk change that is complete enough to submit: full risk assessment, backout and
 *  test plans, a window. Override per test. */
export function readyChange(over: Record<string, unknown> = {}) {
  return {
    id: CHANGE_ID,
    ticketId: TICKET_ID,
    changeKey: "HICS-20261002-0001",
    state: "DRAFT",
    changeKind: "NORMAL",
    environment: "PRODUCTION",
    riskLevel: "HIGH",
    riskScore: 100,
    riskInputs: { impact: "HIGH", data: "HIGH" },
    impact: "MEDIUM",
    likelihood: "MEDIUM",
    dataMigration: false,
    requiresDowntime: false,
    downtimeMinutes: null,
    justification: "<p>Because the certificate expires</p>",
    implementationPlan: "<p>Rotate it</p>",
    backoutPlan: "<p>Restore the old one</p>",
    testPlan: "<p>Hit the endpoint</p>",
    communicationPlan: null,
    plannedStart: new Date("2026-11-01T10:00:00.000Z"),
    plannedEnd: new Date("2026-11-01T11:00:00.000Z"),
    conflictOverrideReason: null,
    conflictOverridden: false,
    submittedAt: null as Date | null,
    approvedAt: null as Date | null,
    actualStart: null as Date | null,
    actualEnd: null as Date | null,
    closedAt: null as Date | null,
    closedById: null as string | null,
    outcome: null,
    pirNotes: null,
    ...over
  };
}

export function createChangeWorld(seed: { change?: Record<string, unknown>; approvals?: Partial<ApprovalRow>[] } = {}) {
  const change: Record<string, any> = readyChange(seed.change);
  const ticket: Record<string, any> = {
    id: TICKET_ID,
    key: "HICS-7",
    title: "Rotate the TLS certificate",
    description: null,
    projectId: "project-1",
    reporterId: "requester-1",
    assigneeId: null,
    status: "OPEN",
    resolvedAt: null,
    closedAt: null
  };
  let approvalSeq = 0;
  const approvals: ApprovalRow[] = (seed.approvals ?? []).map((a) => ({
    id: `appr-${++approvalSeq}`,
    changeId: CHANGE_ID,
    round: 1,
    approverId: "manager-1",
    reason: "MANAGER_OF_REQUESTER",
    status: "PENDING",
    comments: null,
    decidedAt: null,
    dueAt: null,
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
    ...a
  }));

  const users: Record<string, { id: string; name: string; email: string; status: string; managerId: string | null }> = {
    "requester-1": { id: "requester-1", name: "Riya Requester", email: "riya@acme.io", status: "ACTIVE", managerId: "manager-1" },
    "manager-1": { id: "manager-1", name: "Manu Manager", email: "manu@acme.io", status: "ACTIVE", managerId: null },
    "admin-1": { id: "admin-1", name: "Ada Admin", email: "ada@acme.io", status: "ACTIVE", managerId: "manager-1" },
    "sa-1": { id: "sa-1", name: "Sam Super", email: "sam@acme.io", status: "ACTIVE", managerId: null }
  };

  const summary = (id: string | null) => (id && users[id] ? { id, name: users[id].name, email: users[id].email, avatarUrl: null } : null);

  /** The change as `CHANGE_INCLUDE` shapes it — the routes return this, and the mail reads it. */
  const hydrate = () => ({
    ...change,
    category: null,
    source: null,
    application: null,
    collaborators: [],
    linkedTickets: [],
    approvals: [...approvals]
      .sort((a, b) => b.round - a.round || a.createdAt.getTime() - b.createdAt.getTime())
      .map((a) => ({ ...a, approver: summary(a.approverId) })),
    implementationSteps: [],
    testCases: [],
    dependencies: [],
    ticket: {
      ...ticket,
      project: { id: ticket.projectId, code: "HICS", name: "HICS" },
      module: null,
      reporter: summary(ticket.reporterId),
      assignee: summary(ticket.assigneeId),
      _count: { comments: 0, attachments: 0 }
    }
  });

  /** The change as a write-path `findFirst` with a ticket `select` returns it. */
  const withTicket = () => ({ ...change, ticket: { ...ticket } });

  const matchesApproval = (row: ApprovalRow, where: Record<string, any> = {}) =>
    Object.entries(where).every(([key, expected]) => {
      const actual = (row as any)[key];
      if (expected && typeof expected === "object" && !(expected instanceof Date)) {
        if ("not" in expected) return actual !== expected.not;
        if ("in" in expected) return expected.in.includes(actual);
        return true;
      }
      return actual === expected;
    });

  const client: Record<string, any> = {
    $transaction: vi.fn(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(client) : Promise.all(arg as unknown[]))),
    changeRequest: {
      findFirst: vi.fn(async (args: any = {}) => (args.include?.category ? hydrate() : withTicket())),
      findUnique: vi.fn(async (args: any = {}) => (args.include?.category ? hydrate() : withTicket())),
      update: vi.fn(async (args: any) => {
        Object.assign(change, args.data);
        return args.include?.category ? hydrate() : withTicket();
      })
    },
    changeApproval: {
      findFirst: vi.fn(async (args: any = {}) => {
        const rows = approvals.filter((a) => matchesApproval(a, args.where)).sort((a, b) => b.round - a.round);
        return rows[0] ?? null;
      }),
      findMany: vi.fn(async (args: any = {}) => approvals.filter((a) => matchesApproval(a, args.where))),
      createMany: vi.fn(async (args: any) => {
        for (const row of args.data) {
          approvals.push({ id: `appr-${++approvalSeq}`, comments: null, decidedAt: null, dueAt: null, createdAt: new Date(), ...row });
        }
        return { count: args.data.length };
      }),
      update: vi.fn(async (args: any) => {
        const row = approvals.find((a) => a.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }),
      updateMany: vi.fn(async (args: any) => {
        const rows = approvals.filter((a) => matchesApproval(a, args.where));
        for (const row of rows) Object.assign(row, args.data);
        return { count: rows.length };
      })
    },
    ticket: {
      update: vi.fn(async (args: any) => {
        Object.assign(ticket, args.data);
        return { ...ticket };
      }),
      findUnique: vi.fn(async () => ({ ...ticket, priority: "MEDIUM", source: "MANUAL", externalReporterEmail: null, reporter: { email: "riya@acme.io" } }))
    },
    changeRiskParameter: {
      findMany: vi.fn(async () => [
        { key: "impact", weight: 10, label: "Impact" },
        { key: "data", weight: 10, label: "Data" }
      ])
    },
    changeDependency: { findMany: vi.fn(async () => []) },
    blackoutPeriod: { findMany: vi.fn(async () => []) },
    changeSlaConfig: { findMany: vi.fn(async () => []) },
    globalChangeSettings: { upsert: vi.fn(async () => ({ id: "global", enableChangeManagement: true, approvalSlaHours: 48 })) },
    user: {
      // resolveChangeApprovers: the requester and their manager.
      findFirst: vi.fn(async (args: any) => {
        const u = users[args.where.id];
        if (!u) return null;
        const manager = u.managerId ? users[u.managerId] : null;
        return { ...u, manager: manager ? { id: manager.id, status: manager.status, deletedAt: null } : null };
      }),
      // With the role in the shape `requireAuth` reads, for code that has to work out a person's
      // authority without a request — the proposal applier.
      findUnique: vi.fn(async (args: any) => {
        const u = users[args.where.id];
        if (!u) return null;
        const role = { "sa-1": "SUPER_ADMIN", "admin-1": "ADMIN", "manager-1": "MANAGER" }[u.id] ?? "EMPLOYEE";
        const keys = ["changes:write", ...(role === "EMPLOYEE" ? [] : ["changes:approve"])];
        return { ...u, deletedAt: null, role: { name: role, permissions: keys.map((key) => ({ permission: { key } })) } };
      }),
      // The super-admin fallback, and the mail's approver lookup.
      findMany: vi.fn(async () => [{ id: "sa-1" }])
    }
  };

  return { client, change, ticket, approvals, users };
}

/** The change router behind the real error handler, under the given tenant client. */
export function buildChangeApp(router: express.Router, client: unknown) {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => tenantContext.run({ orgId: "org-1", orgSlug: "acme", client } as never, () => next()));
  app.use("/api/changes", router);
  app.use(errorHandler);
  return app;
}

/** Run `fn` inside a tenant context, for code that is not behind a route — the dispatcher, the
 *  proposal applier. */
export function inTenant<T>(client: unknown, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ orgId: "org-1", orgSlug: "acme", client } as never, fn);
}

export const ACTORS = {
  requester: { id: "requester-1", name: "Riya Requester", email: "riya@acme.io", role: "EMPLOYEE", permissions: ["changes:write"] },
  manager: { id: "manager-1", name: "Manu Manager", email: "manu@acme.io", role: "MANAGER", permissions: ["changes:write", "changes:approve"] },
  admin: { id: "admin-1", name: "Ada Admin", email: "ada@acme.io", role: "ADMIN", permissions: ["changes:write", "changes:approve"] },
  superAdmin: { id: "sa-1", name: "Sam Super", email: "sam@acme.io", role: "SUPER_ADMIN", permissions: ["changes:write", "changes:approve"] }
};
