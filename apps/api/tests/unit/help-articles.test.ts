/**
 * The in-app manual's contracts — the ones that make it trustworthy rather than merely present.
 *
 * The article CONTENT is prose and no test can vouch for it. What a test CAN pin is the structure
 * the two consumers rely on: that role filtering actually hides the super-admin SOPs from an
 * employee (the Help page and the Ask AI tool both filter through these helpers, so one test covers
 * both surfaces), that search finds the obvious questions people will actually type, and that every
 * screenshot an article names is a file that exists — a manual with a broken image teaches the
 * reader to distrust the text beside it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  helpArticleVisible,
  searchHelpArticles,
  visibleHelpArticles
} from "@timesheet/shared";

describe("article structure", () => {
  it("has unique ids — they are anchors and the assistant's deep links", () => {
    const ids = HELP_ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every article carries a category from the list, real steps and a where", () => {
    for (const a of HELP_ARTICLES) {
      expect(HELP_CATEGORIES, a.id).toContain(a.category);
      expect(a.steps.length, a.id).toBeGreaterThan(0);
      expect(a.where.length, a.id).toBeGreaterThan(5);
      expect(a.keywords.length, a.id).toBeGreaterThan(2);
    }
  });

  it("every named screenshot exists on disk", () => {
    // The same twelve real captures the marketing pages use. `fileURLToPath`, not a string edit on
    // the href — the hand-rolled version of this passed on Windows and ENOENT'd on every CI runner.
    for (const a of HELP_ARTICLES) {
      if (!a.screenshot) continue;
      const full = fileURLToPath(new URL(`../../../web/public/product/${a.screenshot}`, import.meta.url));
      expect(() => readFileSync(full), `${a.id} names missing screenshot ${a.screenshot}`).not.toThrow();
    }
  });
});

describe("role filtering — the same predicate the Help page and the Ask AI tool use", () => {
  it("hides super-admin SOPs from an employee", () => {
    const employee = visibleHelpArticles("EMPLOYEE").map((a) => a.id);
    for (const gated of ["ai-settings", "sso-setup", "install-sop", "platform-admin", "billing-plans"]) {
      expect(employee, `employee should not see ${gated}`).not.toContain(gated);
    }
  });

  it("shows everyone the everyday flows", () => {
    const employee = visibleHelpArticles("EMPLOYEE").map((a) => a.id);
    for (const open of ["sign-in", "log-time", "raise-ticket", "raise-change", "ask-ai", "home-dashboard"]) {
      expect(employee).toContain(open);
    }
  });

  it("gives approvers the approval articles and the super admin everything", () => {
    expect(visibleHelpArticles("MANAGER").map((a) => a.id)).toContain("approve-timesheets");
    expect(visibleHelpArticles("SUPER_ADMIN")).toHaveLength(HELP_ARTICLES.length);
  });

  it("treats an absent roles list as everyone — the deliberate default", () => {
    const open = HELP_ARTICLES.find((a) => !a.roles)!;
    for (const role of ["EMPLOYEE", "TEAM_LEAD", "MANAGER", "ADMIN", "SUPER_ADMIN"] as const) {
      expect(helpArticleVisible(open, role)).toBe(true);
    }
  });
});

describe("search — the questions people will actually type", () => {
  it.each([
    ["raise a ticket", "raise-ticket"],
    ["how do I log time", "log-time"],
    ["approve timesheet", "approve-timesheets"],
    ["change management", "raise-change"],
    ["install", "install-sop"],
    ["scim", "sso-setup"]
  ])("finds the right article first for %j", (query, expected) => {
    const results = searchHelpArticles(query, "SUPER_ADMIN");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(expected);
  });

  it("respects the role inside search, not just inside listing", () => {
    // An employee searching "install" must get nothing rather than a SOP for a page they lack —
    // this is the exact path the Ask AI tool takes.
    expect(searchHelpArticles("install SOP", "EMPLOYEE")).toHaveLength(0);
  });

  it("returns everything visible for an empty query — the Help page's resting state", () => {
    expect(searchHelpArticles("", "EMPLOYEE").length).toBe(visibleHelpArticles("EMPLOYEE").length);
  });

  it("returns nothing for gibberish rather than everything", () => {
    expect(searchHelpArticles("xyzzy quux", "SUPER_ADMIN")).toHaveLength(0);
  });
});
