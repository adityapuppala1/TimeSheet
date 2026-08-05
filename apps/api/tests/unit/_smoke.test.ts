import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../../src/services/ai.service.js";

describe("smoke: NodeNext .js-specifier TS resolution under Vitest", () => {
  it("imports ai.service.ts via its .js specifier and runs a pure function from it", () => {
    const cost = estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000);
    expect(cost).toBe(2 + 10);
  });
});
