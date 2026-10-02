/**
 * Who an overdue TICKET escalates to.
 *
 * THE DEFECT: ticket-sla.service.ts carried the timesheet sweep's old fallback — the first
 * ADMIN/SUPER_ADMIN, with no exclusions — after the timesheet sweep itself had dropped it (audit
 * 2026-10 R3, finding 1). So:
 *  - when that first admin was the ticket's own assignee, the sweep escalated to nobody, though other
 *    admins existed;
 *  - the manager's manager was taken whoever it was — the person who filed the ticket included, who
 *    is already waiting on it — and an agent identity or a deleted account was not ruled out.
 *
 * THE DECISION (integrator): never the assignee; never the reporter when the reporter is a person;
 * prefer the assignee's manager's manager; then an ADMIN/SUPER_ADMIN; only an active, undeleted,
 * non-agent person; with nobody eligible, no TicketEscalation row — the breach is still marked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/ai.service.js", () => ({ suggestStaleTicketNextAction: vi.fn().mockResolvedValue(null) }));

const { processTicketSlaSweep } = await import("../../src/services/ticket-sla.service.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");

interface Person {
  id: string;
  name: string;
  email: string;
  managerId: string | null;
  status: string;
  deletedAt: Date | null;
  isAgent: boolean;
  role: { name: string };
}

const person = (id: string, role: string, managerId: string | null = null, extra: Partial<Person> = {}): Person => ({
  id,
  name: id,
  email: `${id.toLowerCase()}@x.io`,
  managerId,
  status: "ACTIVE",
  deletedAt: null,
  isAgent: false,
  role: { name: role },
  ...extra
});

/** People in account-creation order — oldest first. */
let people: Person[] = [];
let ticket: { assigneeId: string | null; reporterId: string };
let escalations: Array<{ escalatedToId: string; escalatedFromId: string }> = [];
let breachMarked = false;

const byId = (id: string | null | undefined) => people.find((p) => p.id === id) ?? null;

function fakeClient(): PrismaClient {
  const c: any = {
    ticket: {
      findMany: vi.fn(async () => [
        {
          id: "t-1",
          key: "WEB-7",
          title: "Checkout is down",
          type: "BUG",
          priority: "HIGH",
          dueAt: new Date("2026-10-01T00:00:00.000Z"),
          assignee: byId(ticket.assigneeId),
          reporter: byId(ticket.reporterId),
          _count: { comments: 0, branches: 0 }
        }
      ]),
      update: vi.fn(async ({ data }: any) => {
        if (data.slaBreachAt) breachMarked = true;
        return {};
      })
    },
    ticketEscalation: {
      create: vi.fn(async ({ data }: any) => {
        escalations.push(data);
        return data;
      })
    },
    user: {
      // Every shape the sweep has used to read the directory: the owner with their manager chain,
      // the first admin matching a filter, and everyone at once.
      findUnique: vi.fn(async ({ where }: any) => {
        const user = byId(where.id);
        if (!user) return null;
        const manager = byId(user.managerId);
        return { ...user, manager: manager ? { ...manager, manager: byId(manager.managerId) } : null };
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          people.find(
            (p) =>
              (where.status === undefined || p.status === where.status) &&
              (where.deletedAt !== null || p.deletedAt === null) &&
              (where.isAgent === undefined || p.isAgent === where.isAgent) &&
              (!where.id?.notIn || !where.id.notIn.includes(p.id)) &&
              (!where.role?.name?.in || where.role.name.in.includes(p.role.name))
          ) ?? null
        );
      }),
      findMany: vi.fn(async () => people.map((p) => ({ ...p })))
    }
  };
  c.$transaction = vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));
  return c as PrismaClient;
}

const sweep = () => runInTenant(fakeClient(), () => processTicketSlaSweep(new Date("2026-10-02T00:00:00.000Z")), "org-1");
const escalatedTo = () => escalations.map((e) => e.escalatedToId);

beforeEach(() => {
  escalations = [];
  breachMarked = false;
  vi.mocked(dispatchNotification).mockClear();
});

describe("ticket SLA escalation target", () => {
  it("escalates to the assignee's manager's manager", async () => {
    people = [person("ADM", "ADMIN"), person("DIR", "MANAGER"), person("LEAD", "TEAM_LEAD", "DIR"), person("EMP", "EMPLOYEE", "LEAD"), person("REP", "EMPLOYEE")];
    ticket = { assigneeId: "EMP", reporterId: "REP" };
    await sweep();
    expect(escalatedTo()).toEqual(["DIR"]);
  });

  it("never escalates to the person who filed the ticket, even when they are the manager's manager", async () => {
    // The director filed it and assigned it two levels down. They are the one WAITING on it, so an
    // escalation to them asks the wrong person to chase it; an admin gets it instead.
    people = [person("ADM", "ADMIN"), person("DIR", "MANAGER"), person("LEAD", "TEAM_LEAD", "DIR"), person("EMP", "EMPLOYEE", "LEAD")];
    ticket = { assigneeId: "EMP", reporterId: "DIR" };
    await sweep();
    expect(escalatedTo()).toEqual(["ADM"]);
  });

  it("passes over an admin who is the ticket's own assignee and escalates to another admin", async () => {
    // The first admin by account age is the assignee. The old fallback picked them, saw they were the
    // owner, and escalated to nobody — although a second admin could take it.
    people = [person("ADM1", "SUPER_ADMIN"), person("ADM2", "ADMIN"), person("REP", "EMPLOYEE")];
    ticket = { assigneeId: "ADM1", reporterId: "REP" };
    await sweep();
    expect(escalatedTo()).toEqual(["ADM2"]);
  });

  it("does not escalate an unassigned ticket back to the admin who filed it", async () => {
    people = [person("ADM1", "ADMIN"), person("ADM2", "ADMIN")];
    ticket = { assigneeId: null, reporterId: "ADM1" };
    await sweep();
    expect(escalatedTo()).toEqual(["ADM2"]);
  });

  it("skips a manager's manager who is not an active person, and falls back to an admin", async () => {
    for (const unfit of [{ status: "DEACTIVATED" }, { deletedAt: new Date("2026-09-01T00:00:00.000Z") }, { isAgent: true }]) {
      escalations = [];
      people = [person("ADM", "ADMIN"), person("DIR", "MANAGER", null, unfit), person("LEAD", "TEAM_LEAD", "DIR"), person("EMP", "EMPLOYEE", "LEAD"), person("REP", "EMPLOYEE")];
      ticket = { assigneeId: "EMP", reporterId: "REP" };
      await sweep();
      expect(escalatedTo(), JSON.stringify(unfit)).toEqual(["ADM"]);
    }
  });

  it("escalates an intake ticket to an admin — a system reporter is no reason to skip anyone", async () => {
    people = [person("ADM", "ADMIN"), person("INTAKE", "EMPLOYEE", null, { email: "email-intake@system.local" })];
    ticket = { assigneeId: null, reporterId: "INTAKE" };
    await sweep();
    expect(escalatedTo()).toEqual(["ADM"]);
  });

  it("with nobody eligible, writes no escalation and tells nobody it was escalated, but still marks the breach", async () => {
    people = [person("ADM", "ADMIN"), person("REP", "EMPLOYEE")];
    ticket = { assigneeId: "ADM", reporterId: "REP" };
    const result = await sweep();
    expect(escalations).toEqual([]);
    expect(result.escalations).toBe(0);
    expect(breachMarked).toBe(true);
    const categories = vi.mocked(dispatchNotification).mock.calls.map((call) => call[0].category);
    expect(categories).not.toContain("ticket.escalation");
  });
});
