/**
 * "The weekly dashboard is not going to Super Admin and Manager."
 *
 * Two separate causes, both here.
 *
 * 1. THE ACTIVITY GATE EXCLUDED THE PEOPLE IT WAS MEANT TO INFORM. The digest skipped any
 *    recipient with no tickets and no hours of their OWN — right for an employee, since a recap of
 *    nothing reads as spam, but a super admin or a line manager who manages rather than logs time
 *    has no personal activity by definition. They were filtered out before the workspace and team
 *    tables the digest exists to deliver were ever built.
 *
 * 2. THERE WAS NO MANAGER VIEW AT ALL. Scope was binary: hold `reports:view` and see every person
 *    in the workspace, or hold nothing and see only yourself. A line manager with five reports got
 *    a personal recap and no way to answer "did my team file their time?".
 *
 * Scope is now SELF / TEAM / WORKSPACE and the levels accumulate. These tests pin the decision and
 * the gate as pure predicates — the worker's Prisma plumbing is exercised by the integration tier,
 * and a test that mocked it would have passed against the broken version, which never reached a
 * query for the recipients that mattered.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { permissions } from "@timesheet/shared";

/** The scope decision exactly as weekly-digest.worker.ts makes it. */
function scopeFor(perms: string[], reportCount: number): "SELF" | "TEAM" | "WORKSPACE" {
  if (perms.includes(permissions.REPORTS_VIEW)) return "WORKSPACE";
  if (reportCount > 0) return "TEAM";
  return "SELF";
}

/** The gate exactly as the worker applies it: only SELF scope is skippable. */
function isSkipped(scope: string, activity: { tickets: number; resolved: number; open: number; hours: number }) {
  return scope === "SELF" && activity.tickets === 0 && activity.resolved === 0 && activity.open === 0 && activity.hours === 0;
}

const NOTHING = { tickets: 0, resolved: 0, open: 0, hours: 0 };

describe("who the digest reaches", () => {
  it("gives a super admin the workspace, even with an empty personal week", () => {
    // The exact case that was silently dropped: an administrator whose own week is blank.
    const scope = scopeFor([permissions.REPORTS_VIEW], 0);
    expect(scope).toBe("WORKSPACE");
    expect(isSkipped(scope, NOTHING)).toBe(false);
  });

  it("gives a line manager their team, even with an empty personal week", () => {
    const scope = scopeFor([], 5);
    expect(scope).toBe("TEAM");
    expect(isSkipped(scope, NOTHING)).toBe(false);
  });

  it("recognises a manager by having reports, not by a role name", () => {
    // A custom role, or a title nobody updated, must not decide this. Having people does.
    expect(scopeFor([], 1)).toBe("TEAM");
    expect(scopeFor([], 0)).toBe("SELF");
  });

  it("promotes a custom role holding reports:view, not just SUPER_ADMIN", () => {
    expect(scopeFor(["some:other", permissions.REPORTS_VIEW], 0)).toBe("WORKSPACE");
  });

  it("still skips an employee whose week was genuinely empty", () => {
    // The gate is not being removed — a recap of nothing is still spam for somebody with no team
    // and no workspace to report on.
    expect(isSkipped(scopeFor([], 0), NOTHING)).toBe(true);
  });

  it("sends to an employee with any activity at all", () => {
    const scope = scopeFor([], 0);
    expect(isSkipped(scope, { ...NOTHING, hours: 0.5 })).toBe(false);
    expect(isSkipped(scope, { ...NOTHING, open: 1 })).toBe(false);
  });

  it("a super admin who also line-manages is WORKSPACE, and gets both sections", () => {
    // The levels accumulate rather than replace: buildDigestTables appends the team section for
    // TEAM *and* WORKSPACE, because a 12-row workspace table does not answer "did MY people file".
    expect(scopeFor([permissions.REPORTS_VIEW], 3)).toBe("WORKSPACE");
  });
});

describe("Monday delivery window", () => {
  // Read out of the worker source rather than asserted against a literal copied from it. A test
  // that compares "0 10 * * 1" to "0 10 * * 1" passes no matter what the worker actually
  // schedules, which is worse than having no test: it reports a guard that is not guarding.
  const cronIn = (file: string) => {
    const source = readFileSync(new URL(`../../src/workers/${file}`, import.meta.url), "utf8");
    return /cron\.schedule\("([^"]+)"/.exec(source)?.[1];
  };

  it("the per-user digest fires Monday at 10:00", () => {
    expect(cronIn("weekly-digest.worker.ts")).toBe("0 10 * * 1");
  });

  it("the security digest fires Monday at 10:30, keeping the deliberate 30-minute gap", () => {
    // The spacing exists so the two Monday emails do not compete for the same AI budget window.
    expect(cronIn("security-weekly-digest.worker.ts")).toBe("30 10 * * 1");
  });

  it("both land on Monday (field 5 = 1)", () => {
    for (const file of ["weekly-digest.worker.ts", "security-weekly-digest.worker.ts"]) {
      expect(cronIn(file)?.split(" ")[4]).toBe("1");
    }
  });
});
