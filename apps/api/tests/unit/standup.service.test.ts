/**
 * V12 9.1 — the stand-up's facts. The rule worth pinning: the model is never the thing that decides
 * what happened, and an empty window never reaches it at all.
 */
import { describe, expect, it } from "vitest";
import {
  excerpt,
  formatStandupFacts,
  isStandupWindow,
  mayWriteStandupFor,
  standupIsEmpty,
  standupPeriodLabel,
  standupSubjectRule,
  type StandupFacts
} from "../../src/services/standup.service.js";

const EMPTY: StandupFacts = { movedTickets: [], commentsWritten: [], hoursLogged: 0, timesheetTickets: [], openAssignedComments: [] };

describe("stand-up windows", () => {
  it("accepts only the three periods the card offers", () => {
    expect(isStandupWindow(24)).toBe(true);
    expect(isStandupWindow(72)).toBe(true);
    expect(isStandupWindow(168)).toBe(true);
    for (const bad of [0, 1, 25, 169, -24, 100000]) expect(isStandupWindow(bad)).toBe(false);
  });
  it("names each period the way a sentence would", () => {
    expect(standupPeriodLabel(24)).toBe("the last 24 hours");
    expect(standupPeriodLabel(72)).toBe("the last 3 days");
    expect(standupPeriodLabel(168)).toBe("the last 7 days");
  });
});

describe("standupIsEmpty", () => {
  it("is empty only when every source is", () => {
    expect(standupIsEmpty(EMPTY)).toBe(true);
    expect(standupIsEmpty({ ...EMPTY, hoursLogged: 0.5 })).toBe(false);
    expect(standupIsEmpty({ ...EMPTY, movedTickets: [{ key: "X-1", title: "t", status: "OPEN" }] })).toBe(false);
    expect(standupIsEmpty({ ...EMPTY, commentsWritten: [{ ticketKey: "X-1", excerpt: "hi" }] })).toBe(false);
    expect(standupIsEmpty({ ...EMPTY, openAssignedComments: [{ ticketKey: "X-1", from: "Ana", excerpt: "please" }] })).toBe(false);
  });
});

describe("formatStandupFacts", () => {
  const full: StandupFacts = {
    movedTickets: [{ key: "WEB-12", title: "Checkout returns 500", status: "IN_PROGRESS" }],
    commentsWritten: [{ ticketKey: "WEB-12", excerpt: "Reproduced on Safari only." }],
    hoursLogged: 6.5,
    timesheetTickets: ["WEB-12", "WEB-13"],
    openAssignedComments: [{ ticketKey: "OPS-3", from: "Ana", excerpt: "Check the totals." }]
  };

  it("carries every fact, with keys in brackets and the status in words", () => {
    const out = formatStandupFacts(full);
    expect(out).toContain("- [WEB-12] Checkout returns 500 (now in progress)");
    expect(out).toContain("- on [WEB-12]: Reproduced on Safari only.");
    expect(out).toContain("Time logged: 6.5 hours across WEB-12, WEB-13");
    expect(out).toContain("- on [OPS-3], from Ana: Check the totals.");
  });

  it("says (none) rather than leaving a section out, so the model cannot fill the silence", () => {
    const out = formatStandupFacts(EMPTY);
    expect(out).toContain("Tickets assigned to this person that moved: (none)");
    expect(out).toContain("Comments this person wrote: (none)");
    expect(out).toContain("Time logged: (none recorded)");
    expect(out).toContain("Comments assigned to this person and still unresolved: (none)");
  });

  it("caps each list, because a week of activity has no UI-enforced bound", () => {
    const many: StandupFacts = {
      ...EMPTY,
      movedTickets: Array.from({ length: 40 }, (_, i) => ({ key: `X-${i}`, title: "t", status: "OPEN" })),
      commentsWritten: Array.from({ length: 40 }, (_, i) => ({ ticketKey: `X-${i}`, excerpt: "c" })),
      openAssignedComments: Array.from({ length: 40 }, (_, i) => ({ ticketKey: `X-${i}`, from: "Ana", excerpt: "c" }))
    };
    const out = formatStandupFacts(many);
    expect(out.match(/^- \[X-\d+]/gm)?.length).toBe(25);
    expect(out.match(/^- on \[X-\d+]: /gm)?.length).toBe(15);
    expect(out.match(/^- on \[X-\d+], from Ana: /gm)?.length).toBe(10);
  });
});

describe("excerpt", () => {
  it("strips markup, collapses whitespace and truncates with an ellipsis", () => {
    expect(excerpt("<p>Hello   <b>there</b></p>")).toBe("Hello there");
    const long = excerpt(`<p>${"a".repeat(400)}</p>`);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBe(161);
  });
  it("never leaks a tag, even from a malformed body", () => {
    expect(excerpt("<script>alert(1)</script>ok")).not.toContain("<");
  });
});

/* V12 9.3 — whose stand-up you may write. The picker and the route both ask this one function. */
describe("standupSubjectRule", () => {
  const ME = "me";
  const REPORTS = ["r1", "r2"];

  it("an employee is offered themselves and nobody else", () => {
    const rule = standupSubjectRule("EMPLOYEE", ME, []);
    expect(rule).toEqual({ unrestricted: false, allowedIds: [ME] });
    expect(mayWriteStandupFor(rule, ME)).toBe(true);
    expect(mayWriteStandupFor(rule, "someone")).toBe(false);
  });

  it("ignores reports handed to a role that cannot have them", () => {
    // Defence in depth: if a caller ever passes reports for an EMPLOYEE, the rule still says no.
    const rule = standupSubjectRule("EMPLOYEE", ME, REPORTS);
    expect(rule.allowedIds).toEqual([ME]);
    expect(mayWriteStandupFor(rule, "r1")).toBe(false);
  });

  it("a manager or team lead adds their direct reports, themselves included once", () => {
    for (const role of ["MANAGER", "TEAM_LEAD"]) {
      const rule = standupSubjectRule(role, ME, [...REPORTS, ME]);
      expect(rule.unrestricted).toBe(false);
      expect(rule.allowedIds).toEqual([ME, "r1", "r2"]);
      expect(mayWriteStandupFor(rule, "r2")).toBe(true);
      expect(mayWriteStandupFor(rule, "stranger")).toBe(false);
    }
  });

  it("an admin is unrestricted, and an unknown role is treated as an employee", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN"]) {
      const rule = standupSubjectRule(role, ME, []);
      expect(rule.unrestricted).toBe(true);
      expect(mayWriteStandupFor(rule, "anyone-at-all")).toBe(true);
    }
    // A role this build does not know must degrade to the floor, never to "everyone".
    const unknown = standupSubjectRule("SOMETHING_NEW", ME, REPORTS);
    expect(unknown).toEqual({ unrestricted: false, allowedIds: [ME] });
  });
});
