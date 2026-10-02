/**
 * The words on a change's lifecycle buttons.
 *
 * A move's label depends on where the change is coming FROM, not only where it is going. DRAFT is
 * reached two ways: reopening a rejected or cancelled change, and withdrawing one that is waiting for
 * approval so its locked plan can be changed. "Reopen as draft" on a change nobody has rejected reads
 * as a mistake, and the requester looking for how to edit a submitted change will not find it.
 */
import { describe, expect, it } from "vitest";
import { CHANGE_KIND_MEANING, changeActionLabel } from "../../src/lib/change-visuals";

/**
 * What the type picker promises. Picking a type changes nothing about who decides a change: every
 * type goes to the requester's manager (or the super admins). Standard changes KEEP requiring
 * approval by decision — with no catalogue of approved templates, auto-approving a type the
 * requester picks freely would be a loophole. So the picker must not say "pre-approved", and must
 * not imply an emergency gets a faster or different decision.
 */
describe("CHANGE_KIND_MEANING", () => {
  it("does not promise that a standard change skips approval", () => {
    expect(CHANGE_KIND_MEANING.STANDARD).not.toMatch(/pre-?approved/i);
    expect(CHANGE_KIND_MEANING.STANDARD).toMatch(/approv/i);
  });

  it("does not promise an emergency change a different decision path", () => {
    expect(CHANGE_KIND_MEANING.EMERGENCY).not.toMatch(/cannot wait for the usual decision/i);
    expect(CHANGE_KIND_MEANING.EMERGENCY).toMatch(/same approv/i);
  });
});

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
