import { describe, expect, it } from "vitest";
import { countRows, driftText, minuteText, pctText, rangeFor } from "../../src/lib/attendance-analytics";

describe("attendance analytics formatting", () => {
  it("renders an unmeasured rate as a dash, never 0%", () => {
    expect(pctText(null)).toBe("—");
    expect(pctText(0)).toBe("0%");
    expect(pctText(0.866)).toBe("87%");
  });

  it("formats minutes after midnight as a clock time", () => {
    expect(minuteText(545)).toBe("09:05");
    expect(minuteText(null)).toBe("—");
  });

  it("describes drift in words", () => {
    expect(driftText(12.4)).toBe("+12 min/wk later");
    expect(driftText(-6)).toBe("6 min/wk earlier");
    expect(driftText(1)).toBe("Steady");
    expect(driftText(null)).toBe("—");
  });

  it("builds an inclusive range ending today", () => {
    expect(rangeFor(7, "2026-11-23")).toEqual({ from: "2026-11-17", to: "2026-11-23" });
  });

  it("orders count rows largest first and drops zeros", () => {
    expect(countRows({ SYSTEM_ISSUE: 1, FORGOT: 3, SICK: 0 })).toEqual([
      { key: "FORGOT", label: "Forgot", count: 3 },
      { key: "SYSTEM_ISSUE", label: "System issue", count: 1 }
    ]);
  });
});
