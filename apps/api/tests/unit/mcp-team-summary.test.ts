/**
 * Ask AI / MCP's `get_team_summary` — "is anyone breaching approval SLA?" for a manager's reports.
 *
 * Its `slaBreached` counted entries with `slaBreachAt` set, which only the SLA_ENABLED sweep writes.
 * Wherever the sweep is off it said 0 while the Team page, Reports and the home page — which read
 * the approval deadline — said otherwise. It uses the same rule now: `(reviewedAt ?? now) >
 * approvalDeadline`.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
// The timesheet controller drags in multer and the image pipeline; this tool does not use it.
vi.mock("../../src/controllers/timesheet.controller.js", () => ({ timesheetRouter: express.Router(), saveTimesheet: vi.fn() }));

const { invokeMcpTool } = await import("../../src/services/mcp-tools.js");

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

const user = { id: "mgr", name: "Meera", email: "meera@acme.test", role: "MANAGER", permissions: [] };

function clientWith(timesheets: Array<Record<string, unknown>>): PrismaClient {
  return {
    user: {
      findMany: vi.fn(async () => [
        { name: "Asha", email: "asha@acme.test", status: "ACTIVE", role: { name: "EMPLOYEE" }, timesheets }
      ])
    }
  } as unknown as PrismaClient;
}

async function summary(timesheets: Array<Record<string, unknown>>) {
  const result = (await runInTenant(clientWith(timesheets), () =>
    invokeMcpTool({ user, req: { user }, caller: { kind: "MCP_CREDENTIAL", id: "cred-1" } }, "get_team_summary", {}, {
      enabled: true,
      allowWrites: false,
      toolOverrides: {}
    })
  )) as { reports: Array<{ stats: { slaBreached: number } }> };
  return result.reports[0].stats;
}

describe("get_team_summary", () => {
  it("counts an approval-SLA breach from the deadline, whether or not the sweep stamped it", async () => {
    const stats = await summary([
      // Still waiting, deadline passed two hours ago, never stamped: breached.
      { status: "SUBMITTED", totalHours: 8, approvalDeadline: hoursAgo(2), reviewedAt: null, slaBreachAt: null },
      // Approved an hour after its deadline: breached.
      { status: "APPROVED", totalHours: 4, approvalDeadline: hoursAgo(5), reviewedAt: hoursAgo(4), slaBreachAt: null },
      // Approved in time: not breached.
      { status: "APPROVED", totalHours: 4, approvalDeadline: hoursAgo(5), reviewedAt: hoursAgo(6), slaBreachAt: null },
      // Deadline still ahead: not breached yet.
      { status: "SUBMITTED", totalHours: 2, approvalDeadline: new Date(NOW + 3_600_000), reviewedAt: null, slaBreachAt: null },
      // No deadline at all (a draft): never breached.
      { status: "DRAFT", totalHours: 1, approvalDeadline: null, reviewedAt: null, slaBreachAt: null }
    ]);
    expect(stats.slaBreached).toBe(2);
  });
});
