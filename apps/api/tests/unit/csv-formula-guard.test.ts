/**
 * The shared CSV escaping (utils/csv.ts) and the timesheet report's line builder: formula
 * neutralisation must look at the value AFTER it is normalised and trimmed, or a leading space,
 * tab or newline walks a formula past the check.
 */
import { describe, expect, it } from "vitest";
import { csvCell } from "../../src/utils/csv.js";
import { toCsvLine } from "../../src/services/timesheet-report.service.js";

describe("csvCell formula neutralisation", () => {
  it("prefixes a plain formula", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-1+1")).toBe("'-1+1");
  });

  it("still catches it behind a leading space, tab or newline", () => {
    expect(csvCell(" =1+1")).toBe("'=1+1");
    expect(csvCell("\t=1+1")).toBe("'=1+1");
    expect(csvCell("\r\n=1+1")).toBe("'=1+1");
    expect(csvCell("\n@cmd")).toBe("'@cmd");
  });

  it("leaves numbers and ordinary text alone", () => {
    expect(csvCell(-2.5)).toBe("-2.5");
    expect(csvCell("-3")).toBe("-3");
    expect(csvCell("Ana Lima")).toBe("Ana Lima");
    expect(csvCell(null)).toBe("");
  });
});

describe("timesheet report toCsvLine", () => {
  it("neutralises formulas, including behind whitespace", () => {
    expect(toCsvLine(["=1+1", " @x", "\t-cmd", "ok", "-4"])).toBe(`"'=1+1","' @x","'\t-cmd","ok","-4"`);
  });
});
