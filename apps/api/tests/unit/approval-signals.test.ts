/** The approver brief's rules (services/approval-signals.service.ts#computeApprovalSignals). */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
const { computeApprovalSignals } = await import("../../src/services/approval-signals.service.js");

const entry = (over: Partial<{ activityType: string; ticketId: string | null; taskDescription: string }> = {}) => ({
  id: "e1",
  userId: "u1",
  workDate: new Date("2026-10-05T00:00:00Z"),
  activityType: over.activityType ?? "Development",
  ticketId: over.ticketId === undefined ? "t1" : over.ticketId,
  taskDescription: over.taskDescription ?? "<p>Implemented the week draft allocation and tests</p>"
});
const codes = (e: ReturnType<typeof entry>, totals = new Map<string, number>(), active = new Set(["u1:2026-10-05"])) =>
  computeApprovalSignals([e], totals, active).get("e1")!.map((s) => s.code);

describe("computeApprovalSignals", () => {
  it("is quiet for a normal entry", () => {
    expect(codes(entry(), new Map([["u1:2026-10-05", 8]]))).toEqual([]);
  });
  it("flags development time without a ticket", () => {
    expect(codes(entry({ ticketId: null }))).toContain("NO_TICKET");
  });
  it("does not ask a meeting for a ticket or ticket activity", () => {
    expect(codes(entry({ activityType: "Meeting", ticketId: null }), new Map(), new Set())).toEqual([]);
  });
  it("flags a day over 10 hours, with the total in the label", () => {
    const out = computeApprovalSignals([entry()], new Map([["u1:2026-10-05", 11.5]]), new Set(["u1:2026-10-05"]));
    expect(out.get("e1")).toEqual([{ code: "LONG_DAY", label: "11.5h logged that day" }]);
  });
  it("flags ticket work on a day with no ticket activity", () => {
    expect(codes(entry(), new Map(), new Set())).toContain("NO_ACTIVITY");
  });
  it("measures the description as text, not HTML", () => {
    expect(codes(entry({ taskDescription: "<p><strong>fix</strong></p>" }))).toContain("THIN_NOTE");
  });
});
