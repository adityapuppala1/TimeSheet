/**
 * The MCP server's security properties, asserted at the endpoint rather than at the helpers it
 * happens to call today (same reasoning as ticket-project-scope.test.ts).
 *
 * The five things that must never regress:
 *   1. A tool dispatches, and runs as the credential's user.
 *   2. A tool whose permission the acting user lacks is refused — and the refusal is audited.
 *   3. Nothing crosses a tenant boundary: no tool accepts an org parameter, and a credential
 *      issued in one workspace does not authenticate in another.
 *   4. A disabled tool is neither listed nor callable.
 *   5. Read-only mode refuses every write tool, whatever its own toggle says.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: auditSpy }));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
// Only the network call is stubbed. WEBHOOK_EVENTS stays real, because services/domain-events.ts
// derives the internal event vocabulary from it — a hand-written copy here would let the two drift
// and the test would keep passing while the seam forwarded the wrong set.
vi.mock("../../src/services/webhook-dispatch.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/webhook-dispatch.service.js")>()),
  dispatchOutboundWebhooks: vi.fn().mockResolvedValue(undefined)
}));
// Stubbed rather than exercised: `log_timesheet_entry` REUSES the controller's saveTimesheet on
// purpose (that is the property worth asserting), and importing the real one drags in multer and
// the image pipeline for no gain here.
const saveTimesheetSpy = vi.fn().mockResolvedValue({
  status: "DRAFT",
  workDate: new Date("2026-08-03T00:00:00.000Z"),
  totalHours: 2
});
vi.mock("../../src/controllers/timesheet.controller.js", () => ({
  timesheetRouter: express.Router(),
  saveTimesheet: saveTimesheetSpy
}));

const { mcpRouter } = await import("../../src/controllers/mcp.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { MCP_TOOLS, isToolEnabled, invokeMcpTool } = await import("../../src/services/mcp-tools.js");

const TOKEN = "tsm_0000000000000000000000000000000000000000000000000000000000000000";

/** An EMPLOYEE-shaped acting user; individual tests widen `permissions`/`role`. */
const actor = {
  id: "user-1",
  name: "Priya",
  email: "priya@acme.test",
  status: "ACTIVE",
  deletedAt: null,
  role: { name: "EMPLOYEE", permissions: [] as Array<{ permission: { key: string } }> }
};

let mcpSettings: { enabled: boolean; allowWrites: boolean; toolOverrides: Record<string, boolean> };
let client: PrismaClient;

function grant(...keys: string[]) {
  actor.role.permissions = keys.map((key) => ({ permission: { key } }));
}

function buildClient(overrides: Partial<Record<string, unknown>> = {}): PrismaClient {
  return {
    globalMcpSettings: {
      upsert: vi.fn().mockImplementation(async () => ({
        id: "global",
        ...mcpSettings,
        updatedAt: new Date(),
        updatedById: null
      }))
    },
    mcpCredential: {
      // The credential row no longer carries the user: `resolveMcpPrincipal` selects `userId` and
      // then goes through `principal.service.ts#loadRequestUser`, so that MCP and the agent
      // runtime share ONE definition of "what is this person allowed to do" rather than each
      // building `req.user` themselves. The second lookup below is that shared one.
      findUnique: vi.fn().mockImplementation(async () => ({
        id: "cred-1",
        name: "Priya's Claude Desktop",
        revokedAt: null,
        userId: actor.id
      })),
      update: vi.fn().mockResolvedValue({})
    },
    // ticketProjectScope: this employee is assigned to proj-mine only.
    userProjectAssignment: { findMany: vi.fn().mockResolvedValue([{ projectId: "proj-mine" }]) },
    user: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockImplementation(async () => actor) },
    project: {
      findFirst: vi.fn().mockResolvedValue({ id: "proj-mine", code: "WEB", name: "Web", status: "ACTIVE" }),
      findMany: vi.fn().mockResolvedValue([{ code: "WEB", name: "Web", description: null, status: "ACTIVE", modules: [] }])
    },
    projectModule: { findFirst: vi.fn().mockResolvedValue({ id: "mod-1" }), findMany: vi.fn().mockResolvedValue([]) },
    ticket: {
      findMany: vi.fn().mockResolvedValue([{ key: "WEB-1", title: "Login broken", status: "OPEN" }]),
      findFirst: vi.fn().mockResolvedValue({ id: "t1", key: "WEB-1", projectId: "proj-mine", status: "OPEN", reporterId: "user-1", assigneeId: null }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ key: "WEB-1", title: "Login broken", description: null }),
      update: vi.fn().mockResolvedValue({ key: "WEB-1" })
    },
    ticketComment: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: "c1", createdAt: new Date() }) },
    timesheet: { aggregate: vi.fn().mockResolvedValue({ _sum: { totalHours: 0 } }), findMany: vi.fn().mockResolvedValue([]) },
    globalTicketSettings: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
    testRun: { findFirst: vi.fn().mockResolvedValue(null) },
    ...overrides
  } as unknown as PrismaClient;
}

function buildApp(tenantClient: PrismaClient = client, orgId = "org-1", orgSlug = "acme") {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    runInTenant(tenantClient, async () => next(), orgId, orgSlug).catch(next);
  });
  app.use("/api/mcp", mcpRouter);
  app.use(errorHandler);
  return app;
}

/** One JSON-RPC round trip over Streamable HTTP, with the Accept header the spec requires. */
function rpc(app: express.Express, method: string, params?: unknown, token: string | null = TOKEN) {
  const req = request(app)
    .post("/api/mcp")
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json");
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send({ jsonrpc: "2.0", id: 1, method, params: params ?? {} });
}

/** The tool result the model actually sees, unwrapped from the JSON-RPC envelope. */
function toolText(body: any): string {
  return body?.result?.content?.[0]?.text ?? "";
}

beforeEach(() => {
  auditSpy.mockClear();
  saveTimesheetSpy.mockClear();
  actor.role = { name: "EMPLOYEE", permissions: [] };
  mcpSettings = { enabled: true, allowWrites: false, toolOverrides: {} };
  client = buildClient();
});

describe("dispatch", () => {
  it("lists the read tools and calls one, as the credential's user", async () => {
    grant(permissions.TICKETS_VIEW);
    const app = buildApp();

    const listed = await rpc(app, "tools/list");
    expect(listed.status).toBe(200);
    const names = listed.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("search_tickets");
    expect(names).toContain("whoami");

    const called = await rpc(app, "tools/call", { name: "whoami", arguments: {} });
    expect(called.status).toBe(200);
    expect(called.body.result.isError).toBeFalsy();
    const payload = JSON.parse(toolText(called.body));
    expect(payload.actingAs).toMatchObject({ email: "priya@acme.test", role: "EMPLOYEE" });
    // The workspace comes from the resolved tenant context, never from the caller.
    expect(payload.workspace).toBe("acme");
    expect(auditSpy).toHaveBeenCalledWith("user-1", "mcp.tool_called", "McpCredential", "cred-1", { tool: "whoami" });
  });

  it("refuses an unauthenticated call, and a revoked credential, identically", async () => {
    const app = buildApp();
    expect((await rpc(app, "tools/list", {}, null)).status).toBe(401);

    vi.mocked(client.mcpCredential.findUnique).mockResolvedValue({ id: "cred-1", revokedAt: new Date(), userId: actor.id } as never);
    expect((await rpc(app, "tools/list")).status).toBe(401);
  });

  it("refuses an EXPIRED credential, and says nothing different than for a bad one", async () => {
    // A standing bearer token held by a language model is the capability nobody revisits, so it
    // can now stop working on its own. Checked at resolve time rather than swept, so the moment it
    // passes is the moment it stops — and so it still expires if a sweep is ever broken.
    const app = buildApp();
    vi.mocked(client.mcpCredential.findUnique).mockResolvedValue({
      id: "cred-1",
      revokedAt: null,
      userId: actor.id,
      expiresAt: new Date(Date.now() - 1000)
    } as never);
    expect((await rpc(app, "tools/list")).status).toBe(401);
  });

  it("still accepts a credential whose expiry has not arrived, and one with no expiry at all", async () => {
    // NULL means never, which is every credential issued before the column existed. Expiring those
    // retroactively on upgrade would break working integrations with no warning.
    const app = buildApp();
    for (const expiresAt of [new Date(Date.now() + 60_000), null]) {
      vi.mocked(client.mcpCredential.findUnique).mockResolvedValue({
        id: "cred-1",
        name: "c",
        revokedAt: null,
        userId: actor.id,
        expiresAt
      } as never);
      expect((await rpc(app, "tools/list")).status, String(expiresAt)).toBe(200);
    }
  });

  it("refuses a credential whose person has been deactivated, without the row changing", async () => {
    // The per-request re-read is what makes offboarding take effect: nobody has to remember to
    // revoke the credential when the account is disabled. Now that it lives in loadRequestUser,
    // it is worth pinning here rather than trusting it survived the extraction.
    const app = buildApp();
    vi.mocked(client.user.findUnique).mockResolvedValue({ ...actor, status: "INACTIVE" } as never);
    expect((await rpc(app, "tools/list")).status).toBe(401);

    vi.mocked(client.user.findUnique).mockResolvedValue({ ...actor, deletedAt: new Date() } as never);
    expect((await rpc(app, "tools/list")).status).toBe(401);
  });

  it("refuses everything while the workspace's master switch is off", async () => {
    mcpSettings.enabled = false;
    const response = await rpc(buildApp(), "tools/list");
    expect(response.status).toBe(404);
  });
});

describe("permissions", () => {
  it("refuses a tool whose permission the acting user does not hold, and audits the denial", async () => {
    grant(); // no permissions at all
    const response = await rpc(buildApp(), "tools/call", { name: "search_tickets", arguments: {} });

    expect(response.status).toBe(200); // a refusal is a tool result, not a transport fault
    expect(response.body.result.isError).toBe(true);
    expect(toolText(response.body)).toContain(permissions.TICKETS_VIEW);
    expect(client.ticket.findMany).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith("user-1", "mcp.tool_denied", "McpCredential", "cred-1", {
      tool: "search_tickets",
      reason: "missing_permission"
    });
  });

  it("every tool that reads or writes shared data names a permission", () => {
    // The only tools allowed to be permission-free are the ones whose entire scope is the caller
    // themselves — if a new tool joins this list, that was a decision, not an oversight.
    const unpermissioned = MCP_TOOLS.filter((t) => t.permission === null).map((t) => t.name);
    expect(unpermissioned.sort()).toEqual(["get_team_summary", "list_my_timesheets", "list_projects", "whoami"]);
  });

  it("the dispatcher, not the handler, is what enforces the permission", async () => {
    // Reaching invokeMcpTool directly with a fully-enabled settings object still fails, because
    // the gate lives in the dispatcher — there is no other way in (a tool's handler is not
    // exported), so this is the whole surface.
    grant();
    await expect(
      runInTenant(client, () =>
        invokeMcpTool(
          { user: { id: "user-1", name: "Priya", email: "priya@acme.test", role: "EMPLOYEE", permissions: [] }, req: { user: { id: "user-1", name: "Priya", email: "priya@acme.test", role: "EMPLOYEE", permissions: [] } }, credentialId: "cred-1" },
          "search_tickets",
          {},
          { enabled: true, allowWrites: true, toolOverrides: { search_tickets: true } }
        )
      )
    ).rejects.toThrow(/tickets:view/);
  });
});

describe("tenant isolation", () => {
  it("no tool accepts an org parameter", () => {
    const forbidden = /^(org|orgid|orgslug|organization|organizationid|tenant|tenantid|workspace|workspaceid)$/i;
    for (const tool of MCP_TOOLS) {
      for (const field of Object.keys(tool.inputSchema)) {
        expect(field, `${tool.name}.${field}`).not.toMatch(forbidden);
      }
    }
  });

  it("a credential from another workspace does not authenticate here", async () => {
    // Each org has its own database, so the lookup runs against THIS tenant's McpCredential table
    // and simply finds nothing — there is no shared table a foreign token could match in.
    const otherOrgClient = buildClient({ mcpCredential: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() } });
    const response = await rpc(buildApp(otherOrgClient, "org-2", "other"), "tools/list");
    expect(response.status).toBe(401);
  });

  it("a tool reads only the client bound to the tenant that served the request", async () => {
    grant(permissions.TICKETS_VIEW);
    const otherTenant = buildClient();
    await rpc(buildApp(client, "org-1", "acme"), "tools/call", { name: "search_tickets", arguments: {} });

    expect(client.ticket.findMany).toHaveBeenCalled();
    expect(otherTenant.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe("per-tool enablement", () => {
  it("a disabled tool is neither listed nor callable", async () => {
    grant(permissions.TICKETS_VIEW);
    mcpSettings.toolOverrides = { search_tickets: false };
    const app = buildApp();

    const listed = await rpc(app, "tools/list");
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("search_tickets");

    const called = await rpc(app, "tools/call", { name: "search_tickets", arguments: {} });
    // Unregistered at the protocol layer AND refused by the dispatcher — either way, no query.
    expect(client.ticket.findMany).not.toHaveBeenCalled();
    expect(called.body.result?.isError ?? Boolean(called.body.error)).toBe(true);
    // …and it is still audited. The SDK refuses an unregistered name before any handler runs, so
    // without the transport-level pre-flight this denial would leave no trace at all.
    expect(auditSpy).toHaveBeenCalledWith("user-1", "mcp.tool_denied", "McpCredential", "cred-1", {
      tool: "search_tickets",
      reason: "tool_disabled"
    });
  });

  it("probing a tool that does not exist is audited too", async () => {
    await rpc(buildApp(), "tools/call", { name: "delete_everything", arguments: {} });
    expect(auditSpy).toHaveBeenCalledWith("user-1", "mcp.tool_denied", "McpCredential", "cred-1", {
      tool: "delete_everything",
      reason: "unknown_tool"
    });
  });

  it("reads default on and writes default off, so a new write tool ships disabled", () => {
    const settings = { enabled: true, allowWrites: true, toolOverrides: {} };
    for (const tool of MCP_TOOLS) {
      expect(isToolEnabled(tool, settings), tool.name).toBe(!tool.mutating);
    }
  });

  it("every tool that can undo nothing by itself is marked destructive", () => {
    expect(MCP_TOOLS.filter((t) => t.destructive).map((t) => t.name)).toEqual(["transition_ticket"]);
    // …and a destructive tool is a write tool, so it is behind both gates, not one.
    expect(MCP_TOOLS.filter((t) => t.destructive).every((t) => t.mutating)).toBe(true);
  });
});

describe("read-only mode", () => {
  it("hides and refuses every write tool while allowWrites is off", async () => {
    grant(permissions.TICKETS_WRITE, permissions.TIMESHEETS_WRITE, permissions.TICKETS_VIEW);
    // Explicitly ON per-tool — the workspace-wide latch must still win.
    mcpSettings.toolOverrides = { create_ticket: true, log_timesheet_entry: true, transition_ticket: true };
    const app = buildApp();

    const listed = await rpc(app, "tools/list");
    const names: string[] = listed.body.result.tools.map((t: { name: string }) => t.name);
    for (const tool of MCP_TOOLS.filter((t) => t.mutating)) expect(names).not.toContain(tool.name);
    expect(names).toContain("search_tickets");

    const called = await rpc(app, "tools/call", {
      name: "log_timesheet_entry",
      arguments: {
        projectCode: "WEB",
        moduleName: "Core",
        workDate: "2026-08-03",
        startTime: "09:00",
        endTime: "11:00",
        activityType: "Development",
        taskDescription: "Fixed the login redirect loop"
      }
    });
    expect(saveTimesheetSpy).not.toHaveBeenCalled();
    expect(called.body.result?.isError ?? Boolean(called.body.error)).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith("user-1", "mcp.tool_denied", "McpCredential", "cred-1", {
      tool: "log_timesheet_entry",
      reason: "read_only_mode"
    });
  });

  it("with writes allowed and the tool enabled, a write goes through the controller's own saver", async () => {
    grant(permissions.TIMESHEETS_WRITE);
    mcpSettings.allowWrites = true;
    mcpSettings.toolOverrides = { log_timesheet_entry: true };

    const response = await rpc(buildApp(), "tools/call", {
      name: "log_timesheet_entry",
      arguments: {
        projectCode: "WEB",
        moduleName: "Core",
        workDate: "2026-08-03",
        startTime: "09:00",
        endTime: "11:00",
        activityType: "Development",
        taskDescription: "Fixed the login redirect loop"
      }
    });

    expect(response.body.result.isError).toBeFalsy();
    // DRAFT, not SUBMITTED: an agent may record work, but a person still submits it.
    expect(saveTimesheetSpy).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ id: "user-1" }) }), "DRAFT");
    expect(JSON.parse(toolText(response.body)).status).toBe("DRAFT");
  });

  it("a write tool the user lacks the permission for stays refused even with writes allowed", async () => {
    grant(); // no timesheets:write
    mcpSettings.allowWrites = true;
    mcpSettings.toolOverrides = { log_timesheet_entry: true };

    const response = await rpc(buildApp(), "tools/call", {
      name: "log_timesheet_entry",
      arguments: {
        projectCode: "WEB",
        moduleName: "Core",
        workDate: "2026-08-03",
        startTime: "09:00",
        endTime: "11:00",
        activityType: "Development",
        taskDescription: "Fixed the login redirect loop"
      }
    });
    expect(response.body.result.isError).toBe(true);
    expect(saveTimesheetSpy).not.toHaveBeenCalled();
  });
});

describe("prompt-injection posture", () => {
  it("results that can carry third-party text are prefixed with the untrusted-content warning", async () => {
    grant(permissions.TICKETS_VIEW);
    const response = await rpc(buildApp(), "tools/call", { name: "search_tickets", arguments: {} });
    expect(toolText(response.body)).toContain("[UNTRUSTED CONTENT]");
  });

  it("the ticket-reading tools are exactly the ones flagged as carrying external text", () => {
    expect(MCP_TOOLS.filter((t) => t.untrustedContent).map((t) => t.name).sort()).toEqual(["get_ticket", "search_tickets"]);
  });
});
