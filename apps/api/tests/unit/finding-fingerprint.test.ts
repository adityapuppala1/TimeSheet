/**
 * `deriveFindingFingerprint` decides whether tonight's scan is reporting a problem we already know
 * about. Everything downstream inherits that decision — the occurrence counter, the risk score's
 * age decay, the insights trend, whether a ticket gets opened — so it is tested here on its own,
 * with no database, no tenant and no HTTP request in the way.
 *
 * The two failure directions are not symmetric, and the tests below are grouped by them:
 *
 *   TOO SENSITIVE (a fingerprint that changes when it should not) manufactures duplicates. That is
 *   the bug the whole feature exists to fix, and the line-window tests are the guard on it.
 *
 *   TOO BLUNT (a fingerprint that stays the same when it should not) MERGES two real
 *   vulnerabilities into one row and quietly halves a count a security team works from. That is
 *   the more dangerous direction, and the "different things stay different" tests guard it.
 */
import { describe, expect, it } from "vitest";
import { deriveFindingFingerprint } from "../../src/utils/finding-fingerprint.js";

const base = {
  tool: "semgrep",
  cwe: "CWE-89",
  filePath: "src/db/query.ts",
  lineNumber: 120
};

describe("the same problem, reported twice", () => {
  it("fingerprints identically across two scans of an unchanged file", () => {
    expect(deriveFindingFingerprint(base)).toBe(deriveFindingFingerprint({ ...base }));
  });

  it("survives a line drift inside the window — the reason a window exists at all", () => {
    // Somebody adds an import at the top of the file. The vulnerability did not move; the text
    // above it did. Keyed on the exact line this is a brand-new finding, the old one stops being
    // reported, and the workspace acquires a duplicate every time anyone edits the file.
    expect(deriveFindingFingerprint({ ...base, lineNumber: 110 })).toBe(deriveFindingFingerprint(base));
    expect(deriveFindingFingerprint({ ...base, lineNumber: 149 })).toBe(deriveFindingFingerprint(base));
  });

  it("ignores the ways two CI runners spell the same path", () => {
    // One runner reports a repo-relative path, SARIF reports a file:// URI, a Windows agent
    // reports backslashes. Same file. Left unnormalised, one repository scanned from two agents
    // produces two of every finding.
    const canonical = deriveFindingFingerprint(base);
    expect(deriveFindingFingerprint({ ...base, filePath: "./src/db/query.ts" })).toBe(canonical);
    expect(deriveFindingFingerprint({ ...base, filePath: "/src/db/query.ts" })).toBe(canonical);
    expect(deriveFindingFingerprint({ ...base, filePath: "src\\db\\query.ts" })).toBe(canonical);
    expect(deriveFindingFingerprint({ ...base, filePath: "file:///src/db/query.ts" })).toBe(canonical);
    expect(deriveFindingFingerprint({ ...base, filePath: "src//db//query.ts" })).toBe(canonical);
  });

  it("ignores the tool's casing and the CWE's casing, but not the path's", () => {
    expect(deriveFindingFingerprint({ ...base, tool: "SemGrep" })).toBe(deriveFindingFingerprint(base));
    expect(deriveFindingFingerprint({ ...base, cwe: "cwe-89" })).toBe(deriveFindingFingerprint(base));
    // Paths ARE case-sensitive on the Linux hosts being scanned; folding case here would merge two
    // genuinely different files.
    expect(deriveFindingFingerprint({ ...base, filePath: "src/DB/query.ts" })).not.toBe(deriveFindingFingerprint(base));
  });

  it("ignores the wording of the finding, which scanners rewrite between versions", () => {
    // Title, description and severity are deliberately not inputs. A scanner re-scoring a rule
    // from HIGH to CRITICAL, or rewording its message, must not make an existing finding look new.
    // The signature proves it by construction: there is nowhere to pass them.
    const withEverything = deriveFindingFingerprint({ ...base, ruleId: undefined });
    expect(withEverything).toBe(deriveFindingFingerprint(base));
  });
});

describe("different problems stay different", () => {
  it("separates two findings in different files", () => {
    expect(deriveFindingFingerprint({ ...base, filePath: "src/db/other.ts" })).not.toBe(deriveFindingFingerprint(base));
  });

  it("separates two different rules in the same place", () => {
    expect(deriveFindingFingerprint({ ...base, cwe: "CWE-79" })).not.toBe(deriveFindingFingerprint(base));
  });

  it("separates two tools reporting the same line", () => {
    // Two scanners agreeing is not one finding: they have different false-positive rates and get
    // triaged separately, and collapsing them would hide that only one of them still reports it.
    expect(deriveFindingFingerprint({ ...base, tool: "codeql" })).not.toBe(deriveFindingFingerprint(base));
  });

  it("separates two instances of the same rule far apart in one file", () => {
    // The other half of the window's job. If the window swallowed a whole file, every SQL-injection
    // warning in it would collapse into one row and the count would be wrong in the direction that
    // makes a workspace look safer than it is.
    expect(deriveFindingFingerprint({ ...base, lineNumber: 400 })).not.toBe(deriveFindingFingerprint(base));
  });

  it("does not treat 'the tool did not say where' as line zero", () => {
    // A missing line number is its own bucket. Folding it into the first window would merge every
    // location-less finding of a rule with the ones at the top of the file.
    expect(deriveFindingFingerprint({ ...base, lineNumber: undefined })).not.toBe(deriveFindingFingerprint({ ...base, lineNumber: 1 }));
    expect(deriveFindingFingerprint({ ...base, lineNumber: undefined })).toBe(deriveFindingFingerprint({ ...base, lineNumber: null }));
  });
});

describe("a rule id is the fallback identity, not an equal one", () => {
  it("is used when the tool tags no CWE", () => {
    const byRule = deriveFindingFingerprint({ tool: "semgrep", ruleId: "js.express.audit.xss", filePath: "src/a.ts", lineNumber: 10 });
    expect(byRule).not.toBeNull();
    expect(byRule).toBe(deriveFindingFingerprint({ tool: "semgrep", ruleId: "js.express.audit.xss", filePath: "src/a.ts", lineNumber: 12 }));
  });

  it("is ignored when a CWE is present, so a scanner renaming its rules changes nothing", () => {
    // Rule ids get renamed between scanner releases; a CWE does not. Preferring the CWE is what
    // stops a whole workspace's findings looking new the morning after a scanner upgrade.
    const before = deriveFindingFingerprint({ ...base, ruleId: "old.rule.name" });
    const after = deriveFindingFingerprint({ ...base, ruleId: "new.rule.name" });
    expect(before).toBe(after);
  });
});

describe("no identity is a legitimate answer", () => {
  // Null means "ingest this the old way", never "drop it". Losing a real vulnerability because we
  // could not name it would be far worse than storing it twice — see the ingest's own comment.
  it("returns null with no file path", () => {
    expect(deriveFindingFingerprint({ ...base, filePath: undefined })).toBeNull();
    expect(deriveFindingFingerprint({ ...base, filePath: null })).toBeNull();
    expect(deriveFindingFingerprint({ ...base, filePath: "   " })).toBeNull();
  });

  it("returns null with neither a CWE nor a rule id", () => {
    expect(deriveFindingFingerprint({ ...base, cwe: undefined })).toBeNull();
    expect(deriveFindingFingerprint({ ...base, cwe: "", ruleId: "" })).toBeNull();
  });

  it("returns null with no tool", () => {
    expect(deriveFindingFingerprint({ ...base, tool: "" })).toBeNull();
  });
});

describe("the stored value", () => {
  it("carries its recipe version and fits the column", () => {
    const value = deriveFindingFingerprint(base)!;
    // The prefix is what makes a future change to the recipe visible instead of silent — old rows
    // keep v1 and can never collide with a v2 derivation. `SecurityFinding.fingerprint` is
    // VARCHAR(128); a truncated hash would silently merge unrelated findings.
    expect(value).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(value.length).toBeLessThanOrEqual(128);
  });
});
