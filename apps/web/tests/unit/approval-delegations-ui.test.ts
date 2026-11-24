import { describe, expect, it } from "vitest";
import { delegationLine } from "../../src/components/attendance/ApprovalDelegations";

const d = { delegator: { id: "a", name: "Ravi" }, delegate: { id: "b", name: "Priya" }, startDate: "2026-12-01", endDate: "2026-12-05" };

describe("delegationLine", () => {
  it("reads from the viewer's side", () => {
    expect(delegationLine(d, "a")).toBe("Priya covers your approvals, 2026-12-01 to 2026-12-05");
    expect(delegationLine(d, "b")).toBe("You cover Ravi, 2026-12-01 to 2026-12-05");
    expect(delegationLine(d, "admin")).toBe("Priya covers Ravi, 2026-12-01 to 2026-12-05");
  });
});
