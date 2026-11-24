/**
 * The leave reason is optional, travels on Apply, and is shown to the APPROVER in ApprovalCard
 * (the API returns it only to whoever may decide the request). Also: bulk decisions are sent in
 * chunks of the server's cap.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalCard, approverReason } from "../../src/components/attendance/ApprovalCard";
import { applyPayload, BULK_DECISION_MAX, chunkIds, type LeaveRequestRow } from "../../src/services/leave-api";

const base = { leaveTypeId: "t", startDate: "2026-12-01", endDate: "2026-12-01" };

describe("Apply carries the optional reason", () => {
  it("trims it, and leaves it out when blank", () => {
    expect(applyPayload(base, "  Family wedding  ")).toEqual({ ...base, reason: "Family wedding" });
    expect(applyPayload(base, "   ")).toEqual(base);
    expect("reason" in applyPayload(base, "")).toBe(false);
  });
});

const row = (over: Partial<LeaveRequestRow> = {}) =>
  ({
    id: "r1",
    user: { id: "emp", name: "Aanya Sharma", email: "a@x.io", avatarUrl: null },
    leaveType: { id: "t", code: "PL", name: "Privilege leave", colour: "primary", isPaid: true },
    startDate: "2026-12-01",
    endDate: "2026-12-01",
    startHalf: "FULL",
    endHalf: "FULL",
    days: 1,
    leaveYear: 2026,
    reason: null,
    status: "PENDING",
    attachment: null,
    balanceAfter: 5,
    ...over
  }) as unknown as LeaveRequestRow;

const render = (r: LeaveRequestRow) => renderToStaticMarkup(createElement(ApprovalCard, { request: r, overlap: null, onApprove: () => undefined, onReject: () => undefined }));

describe("ApprovalCard shows the approver the reason", () => {
  it("renders it when the API sent it", () => {
    const html = render(row({ reason: "Hospital appointment" }));
    expect(html).toContain("Reason");
    expect(html).toContain("Hospital appointment");
  });

  it("renders no Reason row when there is none or it was withheld", () => {
    expect(render(row({ reason: null }))).not.toContain(">Reason<");
    expect(approverReason({ reason: "   " })).toBeNull();
  });
});

describe("bulk decisions are chunked to the server's cap", () => {
  it("splits 120 ids into 50 + 50 + 20, in order", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids, BULK_DECISION_MAX);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(chunks.flat()).toEqual(ids);
  });
});
