import { describe, expect, it } from "vitest";
import { cancellableByAdmin } from "../../src/components/attendance/AdminCancelLeave";
import type { LeaveRequestRow } from "../../src/services/leave-api";

const row = (id: string, status: LeaveRequestRow["status"], startDate: string, endDate: string) => ({ id, status, startDate, endDate }) as LeaveRequestRow;

describe("cancellableByAdmin", () => {
  it("keeps approved leave that has not ended, soonest first", () => {
    const out = cancellableByAdmin(
      [row("b", "APPROVED", "2026-12-10", "2026-12-11"), row("past", "APPROVED", "2026-11-01", "2026-11-02"), row("p", "PENDING", "2026-12-01", "2026-12-01"), row("a", "APPROVED", "2026-11-20", "2026-11-25")],
      "2026-11-24"
    );
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("approverLine", () => {
  it("names the manager, or the admin pool", async () => {
    const { approverLine } = await import("../../src/components/attendance/LeaveProfileSummary");
    expect(approverLine({ name: "Mira" })).toBe("Mira");
    expect(approverLine(null)).toBe("Workspace admins (no manager set)");
  });
});
