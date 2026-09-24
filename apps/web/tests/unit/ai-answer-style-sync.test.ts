/**
 * C11: the answer style now lives on the person's profile, and the browser keeps a copy. Two
 * stores means a rule about which one wins, and that rule is the whole feature — so it is a pure
 * function with a test rather than an `if` buried in a component.
 *
 * THE RULE: the saved profile preference wins whenever there is one, because it is the one that
 * followed the person here. The browser copy is what answers before the profile has loaded, what
 * answers when the save failed, and what carries the choice for anybody who made it before this
 * existed. "default" is not a preference — it is the absence of one — so it never wins anything.
 */
import { describe, expect, it } from "vitest";
import { resolveAnswerStyle } from "../../src/lib/ai-answer-style";

describe("which of the two stores wins", () => {
  it("prefers the profile, because that is the copy that travels", () => {
    expect(resolveAnswerStyle("detailed", "concise")).toBe("detailed");
  });

  it("falls back to this browser while the profile has not answered yet", () => {
    // The first paint after a reload: the profile request is still in flight.
    expect(resolveAnswerStyle(undefined, "concise")).toBe("concise");
  });

  it("falls back to this browser for a choice made before the profile could hold one", () => {
    expect(resolveAnswerStyle(null, "checklist")).toBe("checklist");
  });

  it("treats default as the absence of a preference, on either side", () => {
    // A profile that says "default" must not override a browser that says "concise" — the person
    // never chose default, it is simply what no choice looks like.
    expect(resolveAnswerStyle("default", "concise")).toBe("concise");
    expect(resolveAnswerStyle(null, "default")).toBe("default");
  });

  it("ignores a style neither side can honour", () => {
    // A withdrawn style, a hand-edited row, a corrupted localStorage value.
    expect(resolveAnswerStyle("terse" as never, "concise")).toBe("concise");
    expect(resolveAnswerStyle(null, "terse" as never)).toBe("default");
    expect(resolveAnswerStyle("terse" as never, "terse" as never)).toBe("default");
  });

  it("answers for somebody who has never chosen anywhere", () => {
    expect(resolveAnswerStyle(null, "default")).toBe("default");
    expect(resolveAnswerStyle(undefined, "default")).toBe("default");
  });
});
