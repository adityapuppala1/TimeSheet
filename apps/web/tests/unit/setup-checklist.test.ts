import { describe, expect, it } from "vitest";
import { summarizeSetup } from "../../src/lib/setup-checklist";

describe("setup checklist", () => {
  it("counts workspace and personal tasks together without mutating their input", () => {
    const steps = [
      { key: "photo", done: true },
      { key: "agent", done: false },
      { key: "face", done: false, blocking: true }
    ];
    const result = summarizeSetup(steps);
    expect(result.total).toBe(3);
    expect(result.completed).toBe(1);
    expect(result.hasBlockingOpen).toBe(true);
    expect(result.ordered.map((step) => step.key)).toEqual(["face", "agent", "photo"]);
    expect(steps[0].key).toBe("photo");
  });

  it("allows dismissal after required steps are completed", () => {
    expect(summarizeSetup([{ done: true, blocking: true }, { done: false }]).hasBlockingOpen).toBe(false);
  });

  it("keeps completed milestones in the progress denominator", () => {
    expect(summarizeSetup([{ done: true }, { done: true }])).toMatchObject({ total: 2, completed: 2 });
    expect(summarizeSetup([])).toMatchObject({ total: 0, completed: 0, hasBlockingOpen: false });
  });
});
