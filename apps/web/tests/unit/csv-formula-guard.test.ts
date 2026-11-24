/**
 * Formula neutralisation in the two client-side CSV builders: a leading space, tab or newline in
 * front of = + - @ must not walk a formula past the guard.
 */
import { describe, expect, it } from "vitest";
import { csvCell as orgCell } from "../../src/lib/csv-export";
import { csvCell as consoleCell } from "../../src/utils/console-csv";

describe("lib/csv-export csvCell", () => {
  it("catches a formula behind leading whitespace", () => {
    expect(orgCell(" =1+1")).toBe("' =1+1");
    expect(orgCell("\t@x")).toBe("'\t@x");
    expect(orgCell("\n=1+1")).toBe(`"'\n=1+1"`);
    expect(orgCell("-3")).toBe("-3");
  });
});

describe("utils/console-csv csvCell", () => {
  it("catches a formula behind leading whitespace", () => {
    expect(consoleCell(" =1+1")).toBe(`"' =1+1"`);
    expect(consoleCell("\n@x")).toBe(`"'\n@x"`);
    expect(consoleCell("  +cmd")).toBe(`"'  +cmd"`);
  });
});
