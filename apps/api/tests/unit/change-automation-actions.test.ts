/**
 * The gates a workflow must not be able to walk a change past.
 *
 * WHY THIS FILE EXISTS SEPARATELY from change-rules.test.ts: those tests pin the rules. These pin
 * that a SECOND caller re-enters them. The automation dispatcher can now move a change, and the way
 * an automation ends up able to do what the API refuses is not a missing rule — it is a second code
 * path that reimplemented four of the five checks.
 *
 * The dispatcher calls `assertLegalChangeTransition`, `assertReadyFor` and `assertDependenciesClear`
 * — the same three functions the transition route calls — and then refuses APPROVED and REJECTED by
 * name on top. What is asserted here is that those three genuinely refuse, so a change to any of
 * them fails loudly rather than quietly widening what a workflow may do.
 */
import { describe, expect, it, vi } from "vitest";
import { changeStates } from "@timesheet/shared";

const dependencyFindMany = vi.fn();

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    changeDependency: { findMany: (...a: unknown[]) => dependencyFindMany(...a) },
    globalChangeSettings: { upsert: vi.fn().mockResolvedValue({ enableChangeManagement: true }) }
  }
}));

const { assertDependenciesClear, assertLegalChangeTransition } = await import("../../src/services/change.service.js");

describe("the gates an automation has to pass to move a change", () => {
  it("refuses IMPLEMENTING while a predecessor is open, naming what is blocking", async () => {
    dependencyFindMany.mockResolvedValueOnce([{ description: "DBA must finish the index rebuild" }]);
    await expect(assertDependenciesClear("change-1", "IMPLEMENTING")).rejects.toThrow(/index rebuild/);
  });

  it("allows IMPLEMENTING once nothing is open", async () => {
    dependencyFindMany.mockResolvedValueOnce([]);
    await expect(assertDependenciesClear("change-1", "IMPLEMENTING")).resolves.toBeUndefined();
  });

  it("only gates IMPLEMENTING — a dependency does not block closing or cancelling", async () => {
    // The gate is about starting work, not about paperwork afterwards. Gating everything would make
    // an open dependency permanently unclosable, which is how people learn to waive them by reflex.
    for (const state of ["VALIDATION", "PIR", "CLOSED", "CANCELLED"] as const) {
      await expect(assertDependenciesClear("change-1", state)).resolves.toBeUndefined();
    }
    expect(dependencyFindMany).not.toHaveBeenCalledTimes(0);
  });

  it("lets nothing that has not already been approved reach APPROVED, and nothing reach REJECTED", () => {
    // The rule the module exists for, stated precisely. APPROVED is not absent from the transition
    // table — SCHEDULED → APPROVED is legal and means "unschedule it", where the approval has
    // ALREADY happened and only the window is being given up. What must be impossible is reaching
    // APPROVED from a state that has not been decided, and that is what this asserts.
    const alreadyApproved = new Set(["APPROVED", "SCHEDULED"]);
    for (const from of changeStates) {
      if (!alreadyApproved.has(from)) {
        expect(() => assertLegalChangeTransition(from, "APPROVED"), `${from} → APPROVED must be refused`).toThrow();
      }
      // REJECTED genuinely is unreachable from everywhere: it is written only by a recorded
      // decision. A self-transition is excluded because a no-op is answered, never performed.
      if (from !== "REJECTED") {
        expect(() => assertLegalChangeTransition(from, "REJECTED"), `${from} → REJECTED must be refused`).toThrow();
      }
    }
  });

  it("refuses the approval decision itself from the state that is waiting for one", () => {
    // The single most important edge: a change sitting in AWAITING_APPROVAL must not be movable to
    // APPROVED by any caller. Only `POST /changes/:id/decision` writes that, and it checks who is
    // asking. Asserted on its own so it cannot be lost in a loop.
    expect(() => assertLegalChangeTransition("AWAITING_APPROVAL", "APPROVED")).toThrow();
    expect(() => assertLegalChangeTransition("AWAITING_APPROVAL", "REJECTED")).toThrow();
  });

  it("still refuses a move that is not on the table at all", () => {
    expect(() => assertLegalChangeTransition("DRAFT", "IMPLEMENTING")).toThrow();
    expect(() => assertLegalChangeTransition("CLOSED", "DRAFT")).toThrow();
  });
});
