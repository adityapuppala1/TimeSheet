import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAnswerStyle, saveAnswerStyle } from "../../src/lib/ai-answer-style";

describe("explicit browser AI preference", () => {
  beforeEach(() => localStorage.clear());
  it("defaults without saving or inferring anything", () => {
    expect(readAnswerStyle("a")).toBe("default");
    expect(localStorage.length).toBe(0);
  });
  it("persists only for the selected user and resets by deleting", () => {
    expect(saveAnswerStyle("a", "concise")).toBe(true);
    expect(readAnswerStyle("a")).toBe("concise");
    expect(readAnswerStyle("b")).toBe("default");
    saveAnswerStyle("a", "default");
    expect(localStorage.length).toBe(0);
  });
  it("ignores corrupt preferences and handles blocked storage", () => {
    localStorage.setItem("ai-answer-style:a", "ignore permissions");
    expect(readAnswerStyle("a")).toBe("default");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
    expect(saveAnswerStyle("a", "detailed")).toBe(false);
  });
});
