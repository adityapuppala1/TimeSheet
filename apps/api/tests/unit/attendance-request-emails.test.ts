/**
 * Comp-off, attendance corrections and overtime email their approvers and requesters through the
 * leave categories' gates, with their own two templates; ledger rows are labelled by what posted them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEED_TEMPLATES } from "../../prisma/email-templates-seed.js";
import { decidedEmail, requestedEmail } from "../../src/services/attendance-request-mail.js";
import { leaveLedgerLabel } from "../../src/services/leave-ledger-label.js";
import { emailPreferenceKey } from "../../src/services/notify.service.js";

const sql = readFileSync(fileURLToPath(new URL("../../prisma/migrations/20261201100000_attendance_request_emails/migration.sql", import.meta.url)), "utf8");

describe("attendance request emails", () => {
  it("ride the leave toggles, so one switch and the role mutes govern them", () => {
    expect(emailPreferenceKey("leave.requested")).toBe("emailLeaveRequested");
    expect(emailPreferenceKey("leave.decided")).toBe("emailLeaveDecided");
  });

  it("requested mail names the kind and carries no reason", () => {
    const e = requestedEmail({ approverName: "Mira Kapoor", employeeName: "Aanya", kind: "comp-off request", summary: "Worked 2026-06-06, 1 day(s)" });
    expect(e.templateKey).toBe("attendance.requested");
    expect(e.fallback.subject).toBe("Aanya sent a comp-off request for your decision");
    expect(e.fallback.html).toContain("Worked 2026-06-06");
    expect(Object.keys(e.vars)).not.toContain("reason");
  });

  it("decided mail says approved or rejected and falls back to a dash for no note", () => {
    const e = decidedEmail({ name: "Aanya", kind: "overtime claim", approve: false, decidedBy: "Mira", summary: "Week of 2026-06-01, 4h", note: null });
    expect(e.fallback.subject).toBe("Your overtime claim was rejected");
    expect(e.vars.note).toBe("-");
    expect(e.fallback.html).toContain("rejected");
  });

  it("the migration inserts exactly the seeded subjects for both templates", () => {
    for (const key of ["attendance.requested", "attendance.decided"]) {
      expect(sql).toContain(`'${key}'`);
      expect(sql).toContain(SEED_TEMPLATES[key].subject);
    }
    expect(sql).toContain("INSERT IGNORE");
  });
});

describe("leave ledger labels", () => {
  it("names comp-off credits and expiries, not 'adjusted'", () => {
    expect(leaveLedgerLabel("ADJUSTMENT", "COMPOFF:abc")).toBe("Comp-off credit");
    expect(leaveLedgerLabel("EXPIRY", "COMPOFF-EXPIRY:abc")).toBe("Comp-off expired");
    expect(leaveLedgerLabel("ADJUSTMENT", null)).toBe("Adjustment");
    expect(leaveLedgerLabel("DEBIT", "DEBIT:1")).toBe("Leave taken");
  });
});
