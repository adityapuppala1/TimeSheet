/**
 * The words on a change's lifecycle buttons.
 *
 * A move's label depends on where the change is coming FROM, not only where it is going. DRAFT is
 * reached two ways: reopening a rejected or cancelled change, and withdrawing one that is waiting for
 * approval so its locked plan can be changed. "Reopen as draft" on a change nobody has rejected reads
 * as a mistake, and the requester looking for how to edit a submitted change will not find it.
 */
import { describe, expect, it } from "vitest";
import { changeActionLabel } from "../../src/lib/change-visuals";

describe("changeActionLabel", () => {
  it("calls taking back a change that is waiting for approval a withdrawal", () => {
    expect(changeActionLabel("AWAITING_APPROVAL", "DRAFT")).toBe("Withdraw to draft");
  });

  it("still calls reopening a rejected or cancelled change a reopen", () => {
    expect(changeActionLabel("REJECTED", "DRAFT")).toBe("Reopen as draft");
    expect(changeActionLabel("CANCELLED", "DRAFT")).toBe("Reopen as draft");
  });

  it("labels the other moves by where they go", () => {
    expect(changeActionLabel("DRAFT", "AWAITING_APPROVAL")).toBe("Submit for approval");
    expect(changeActionLabel("AWAITING_APPROVAL", "CANCELLED")).toBe("Cancel change");
  });

  it("falls back to the state's name for a move with no label of its own", () => {
    expect(changeActionLabel("SCHEDULED", "APPROVED")).toBe("Approved");
  });
});
