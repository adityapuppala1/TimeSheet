/**
 * Who may work on a ticket, and who may decide who works on it.
 *
 * These two predicates replaced a rule that answered YES for anybody holding `tickets:assign` — a
 * permission every MANAGER and TEAM_LEAD holds tenant-wide, which meant every manager in the
 * workspace could edit and reassign work they had no relationship to. The rule now follows the
 * reporting line, so the cases worth pinning are the ones where a manager is NOT in it: a
 * regression there is silent, and it hands authority back to people who should not have it.
 *
 * The split between the two is the point of the design: doing the work and deciding who does the
 * work are different rights, so an assignee can move their own ticket but cannot hand it away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const collaboratorFindFirst = vi.fn().mockResolvedValue(null);
const userFindFirst = vi.fn().mockResolvedValue(null);

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticketCollaborator: { findFirst: (...a: unknown[]) => collaboratorFindFirst(...a) },
    user: { findFirst: (...a: unknown[]) => userFindFirst(...a) }
  }
}));

const { canReassignTicket, canWorkOnTicket } = await import("../../src/services/ticket.service.js");

const TICKET = { id: "t-1", reporterId: "reporter-1", assigneeId: "assignee-1" };

/** A request shaped the way `requireAuth` leaves it. */
function as(role: string, id: string, permissions: string[] = ["tickets:view", "tickets:write"]) {
  return { user: { id, role, permissions } };
}

beforeEach(() => {
  vi.clearAllMocks();
  collaboratorFindFirst.mockResolvedValue(null);
  userFindFirst.mockResolvedValue(null);
});

describe("canWorkOnTicket", () => {
  it("lets the reporter work on what they raised", async () => {
    expect(await canWorkOnTicket(as("EMPLOYEE", "reporter-1"), TICKET)).toBe(true);
    // Settled on the row itself — no lookup should have been needed.
    expect(collaboratorFindFirst).not.toHaveBeenCalled();
  });

  it("lets the assignee work on what they hold", async () => {
    expect(await canWorkOnTicket(as("EMPLOYEE", "assignee-1"), TICKET)).toBe(true);
  });

  it("lets an explicitly added collaborator work on it", async () => {
    collaboratorFindFirst.mockResolvedValue({ id: "c-1" });
    expect(await canWorkOnTicket(as("EMPLOYEE", "helper-1"), TICKET)).toBe(true);
    expect(collaboratorFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ticketId: "t-1", userId: "helper-1" } })
    );
  });

  it("lets the manager of the assignee work on it", async () => {
    userFindFirst.mockResolvedValue({ id: "assignee-1" });
    expect(await canWorkOnTicket(as("MANAGER", "boss-1", ["tickets:view", "tickets:assign"]), TICKET)).toBe(true);
  });

  it("REFUSES a manager who is not in this ticket's reporting line", async () => {
    // The regression that matters. `tickets:assign` alone used to be enough; it must not be.
    userFindFirst.mockResolvedValue(null);
    expect(await canWorkOnTicket(as("MANAGER", "other-boss", ["tickets:view", "tickets:assign"]), TICKET)).toBe(false);
  });

  it("refuses an unrelated employee", async () => {
    expect(await canWorkOnTicket(as("EMPLOYEE", "stranger-1"), TICKET)).toBe(false);
  });

  it("lets a privileged role through without any lookup", async () => {
    for (const role of ["SUPER_ADMIN", "ADMIN"]) {
      expect(await canWorkOnTicket(as(role, "admin-1"), TICKET)).toBe(true);
    }
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("keeps tickets:manage as a blanket grant, since it can already delete the ticket outright", async () => {
    expect(await canWorkOnTicket(as("MANAGER", "keeper-1", ["tickets:manage"]), TICKET)).toBe(true);
  });

  it("asks about the reporter as well as the assignee", async () => {
    userFindFirst.mockResolvedValue({ id: "reporter-1" });
    expect(await canWorkOnTicket(as("MANAGER", "boss-2", ["tickets:assign"]), TICKET)).toBe(true);
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["reporter-1", "assignee-1"] }, managerId: "boss-2" }) })
    );
  });

  it("does not fall over on an unassigned ticket", async () => {
    const unassigned = { id: "t-2", reporterId: "reporter-1", assigneeId: null };
    expect(await canWorkOnTicket(as("MANAGER", "boss-1", ["tickets:assign"]), unassigned)).toBe(false);
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["reporter-1"] } }) })
    );
  });
});

describe("canReassignTicket", () => {
  it("allows a super admin and an admin", async () => {
    for (const role of ["SUPER_ADMIN", "ADMIN"]) {
      expect(await canReassignTicket(as(role, "admin-1"), TICKET)).toBe(true);
    }
  });

  it("allows the manager the reporter or assignee reports to", async () => {
    userFindFirst.mockResolvedValue({ id: "assignee-1" });
    expect(await canReassignTicket(as("MANAGER", "boss-1", ["tickets:assign"]), TICKET)).toBe(true);
  });

  it("REFUSES the assignee themselves — doing the work is not deciding who does it", async () => {
    expect(await canReassignTicket(as("EMPLOYEE", "assignee-1"), TICKET)).toBe(false);
  });

  it("refuses the reporter", async () => {
    expect(await canReassignTicket(as("EMPLOYEE", "reporter-1"), TICKET)).toBe(false);
  });

  it("refuses a collaborator, who may work on it but not restaff it", async () => {
    collaboratorFindFirst.mockResolvedValue({ id: "c-1" });
    expect(await canReassignTicket(as("EMPLOYEE", "helper-1"), TICKET)).toBe(false);
  });

  it("refuses an unrelated manager even with tickets:assign", async () => {
    userFindFirst.mockResolvedValue(null);
    expect(await canReassignTicket(as("MANAGER", "other-boss", ["tickets:assign", "tickets:manage"]), TICKET)).toBe(false);
  });

  it("is strictly narrower than canWorkOnTicket for the parties on the ticket", async () => {
    // The invariant the two functions exist to express, asserted directly rather than implied by
    // the cases above: everybody who may reassign may also work, and not the reverse.
    const assignee = as("EMPLOYEE", "assignee-1");
    expect(await canWorkOnTicket(assignee, TICKET)).toBe(true);
    expect(await canReassignTicket(assignee, TICKET)).toBe(false);
  });
});
