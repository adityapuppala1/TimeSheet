/**
 * Who can work a change's runbook, as the page decides it — the same rule as the API's
 * `loadChangeForRunbook`: the requester, the implementer, or a change manager.
 *
 * THE DEFECT: the runbook was disabled whenever `canEdit` was false, and `canEdit` is false for the
 * requester and the implementer once a change is approved (the plan freezes). So the implementer
 * could not tick a step done, or record one that failed, during implementation — the one time the
 * runbook is for — although the API would have accepted it and the page's own comment said the
 * runbook is deliberately not frozen.
 */
import { describe, expect, it } from "vitest";
import { canWorkRunbook } from "../../src/utils/change-runbook";

describe("canWorkRunbook", () => {
  it("lets the implementer work the runbook of an approved change they cannot otherwise edit", () => {
    expect(canWorkRunbook({ state: "IMPLEMENTING", canEdit: false }, true)).toBe(true);
  });

  it("lets a change manager work it", () => {
    expect(canWorkRunbook({ state: "SCHEDULED", canEdit: true }, false)).toBe(true);
  });

  it("refuses someone who is neither a party nor a manager", () => {
    expect(canWorkRunbook({ state: "IMPLEMENTING", canEdit: false }, false)).toBe(false);
  });

  it("is read-only once the change is closed", () => {
    expect(canWorkRunbook({ state: "CLOSED", canEdit: true }, true)).toBe(false);
  });
});
