/**
 * Whether the entry dialog offers Approve/Reject — the client's mirror of the server's rule in
 * services/timesheet-approval-scope.service.ts.
 *
 * THE DEFECT (audit 2026-10, timesheets #2): `canDecide` was one boolean for the whole session —
 * "holds timesheets:approve" — so a team lead opening their OWN submitted entry from History or the
 * dashboard got an Approve button beside it, and the server, which checked only the status, let
 * them press it. The server now refuses (403); the dialog must stop offering what it refuses.
 */
import { describe, expect, it } from "vitest";
import { canDecideTimesheet, canReopenTimesheet } from "../../src/lib/timesheet-decision";

const approver = { id: "lead-1", managerId: "mgr-1", permissions: ["timesheets:approve"] };

describe("canDecideTimesheet", () => {
  it("offers a decision on somebody else's entry to an approver", () => {
    expect(canDecideTimesheet(approver, { userId: "emp-1" })).toBe(true);
  });

  it("hides it on your own entry, whatever you hold", () => {
    expect(canDecideTimesheet(approver, { userId: "lead-1" })).toBe(false);
    expect(canDecideTimesheet({ ...approver, permissions: ["timesheets:approve", "users:manage"] }, { userId: "lead-1" })).toBe(false);
  });

  it("hides it on your own manager's entry, which the server refuses too", () => {
    expect(canDecideTimesheet(approver, { userId: "mgr-1" })).toBe(false);
  });

  it("hides it from somebody without timesheets:approve", () => {
    expect(canDecideTimesheet({ ...approver, permissions: [] }, { userId: "emp-1" })).toBe(false);
  });

  it("reads the author from the nested user when the row carries no userId", () => {
    expect(canDecideTimesheet(approver, { user: { id: "lead-1" } })).toBe(false);
    expect(canDecideTimesheet(approver, { user: { id: "emp-1" } })).toBe(true);
  });

  it("offers nothing while either side is still loading", () => {
    expect(canDecideTimesheet(null, { userId: "emp-1" })).toBe(false);
    expect(canDecideTimesheet(approver, null)).toBe(false);
  });
});

/**
 * Reopen — sending an APPROVED entry back to the queue (audit 2026-10, timesheets #4). The same
 * people who may decide may reopen; the author never may.
 */
describe("canReopenTimesheet", () => {
  it("offers Reopen on somebody else's APPROVED entry", () => {
    expect(canReopenTimesheet(approver, { userId: "emp-1", status: "APPROVED" })).toBe(true);
  });

  it("never on your own approved entry", () => {
    expect(canReopenTimesheet(approver, { userId: "lead-1", status: "APPROVED" })).toBe(false);
  });

  it("only on an APPROVED entry", () => {
    for (const status of ["DRAFT", "SUBMITTED", "REJECTED"]) {
      expect(canReopenTimesheet(approver, { userId: "emp-1", status }), status).toBe(false);
    }
  });
});
