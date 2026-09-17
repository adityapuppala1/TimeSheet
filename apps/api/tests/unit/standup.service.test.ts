/**
 * V12 9.1 — the stand-up's facts. The rule worth pinning: the model is never the thing that decides
 * what happened, and an empty window never reaches it at all.
 */
import { describe, expect, it } from "vitest";
import {
  excerpt,
  formatStandupFacts,
  isStandupWindow,
  standupIsEmpty,
  standupPeriodLabel,
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
    expect(out).toContain("Time I logged: 6.5 hours across WEB-12, WEB-13");
    expect(out).toContain("- on [OPS-3], from Ana: Check the totals.");
  });

  it("says (none) rather than leaving a section out, so the model cannot fill the silence", () => {
    const out = formatStandupFacts(EMPTY);
    expect(out).toContain("Tickets assigned to me that moved: (none)");
    expect(out).toContain("Comments I wrote: (none)");
    expect(out).toContain("Time I logged: (none recorded)");
    expect(out).toContain("Comments assigned to me and still unresolved: (none)");
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
