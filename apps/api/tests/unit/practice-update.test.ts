/**
 * The Weekly AI/ML Practice Update — the parts that decide what leadership is told.
 *
 * The split this file pins is the one the whole feature rests on: FIGURES ARE COUNTED, PROSE IS
 * DRAFTED. A model is allowed to be unavailable, slow, or wrong, and the update still has to be a
 * complete and accurate document — so most of what is asserted here is the behaviour when there is
 * no narrative at all.
 *
 * The RAG thresholds are tested as arithmetic on purpose. A red a model chose is not reproducible
 * in the meeting where somebody asks why their project is red.
 */
import { describe, expect, it } from "vitest";

import {
  categoriseInitiative,
  lastCompleteWeek,
  ragFor,
  type PracticeInitiative,
  type PracticeMetrics,
  type PracticeUpdateData
} from "../../src/services/practice-update.service.js";
import { buildPracticeUpdateEmail, narrativeInputs } from "../../src/services/practice-update-mail.service.js";

describe("categoriseInitiative", () => {
  const base = { hoursByActivity: new Map<string, number>(), closedBugs: 0, closedTotal: 0 };

  it("lets the project's NAME decide when it says so outright", () => {
    // A project called "Security Hardening" is that regardless of what got logged against it in
    // any one week.
    expect(categoriseInitiative({ ...base, name: "Security Hardening" })).toBe("SECURITY");
    expect(categoriseInitiative({ ...base, name: "Learnings & Certifications" })).toBe("TRAINING");
    expect(categoriseInitiative({ ...base, name: "Archive Drill" })).toBe("POC");
    expect(categoriseInitiative({ ...base, name: "Payments Platform" })).toBe("PRODUCT");
  });

  it("falls back to what the week's hours were actually spent on", () => {
    expect(
      categoriseInitiative({ ...base, name: "Alpha", hoursByActivity: new Map([["Learning", 8], ["Development", 1]]) })
    ).toBe("TRAINING");
    expect(
      categoriseInitiative({ ...base, name: "Alpha", hoursByActivity: new Map([["POC", 6], ["Development", 1]]) })
    ).toBe("POC");
  });

  it("calls it Bugs/Stability when most of what closed were bugs", () => {
    expect(categoriseInitiative({ ...base, name: "Alpha", closedBugs: 7, closedTotal: 10 })).toBe("BUGS");
    expect(categoriseInitiative({ ...base, name: "Alpha", closedBugs: 3, closedTotal: 10 })).toBe("PRODUCT");
  });

  it("is PRODUCT when there is nothing to go on", () => {
    // The default has to be the harmless one: a mis-filed project is visible and correctable in the
    // draft, but an initiative that vanished from every section would not be.
    expect(categoriseInitiative({ ...base, name: "Alpha" })).toBe("PRODUCT");
  });
});

describe("ragFor", () => {
  it("reserves RED for a breached commitment", () => {
    expect(ragFor({ overdueCount: 0, openCount: 40, slaBreaches: 1 })).toBe("RED");
    // More than a third of what is open is already late.
    expect(ragFor({ overdueCount: 15, openCount: 40, slaBreaches: 0 })).toBe("RED");
  });

  it("is AMBER for anything overdue that has not crossed the threshold", () => {
    expect(ragFor({ overdueCount: 5, openCount: 40, slaBreaches: 0 })).toBe("AMBER");
  });

  it("is GREEN only when nothing is overdue at all", () => {
    expect(ragFor({ overdueCount: 0, openCount: 40, slaBreaches: 0 })).toBe("GREEN");
    expect(ragFor({ overdueCount: 0, openCount: 0, slaBreaches: 0 })).toBe("GREEN");
  });
});

describe("lastCompleteWeek", () => {
  it("is the Monday-to-Sunday before the current week", () => {
    // Thursday 27 August 2026 → the week of Mon 17 to Sun 23, not the partial current one. A
    // digest that reported a half-finished week would compare it against a whole one.
    const week = lastCompleteWeek(new Date(2026, 7, 27));
    expect(week.from.getDay()).toBe(1);
    expect(week.to.getDay()).toBe(0);
    expect(week.label).toBe("17 Aug – 23 Aug 2026");
  });

  it("does not return the week in progress when run ON a Monday", () => {
    const week = lastCompleteWeek(new Date(2026, 7, 24));
    expect(week.label).toBe("17 Aug – 23 Aug 2026");
  });
});

const metrics = (over: Partial<PracticeMetrics> = {}): PracticeMetrics => ({
  ticketsCreated: 20,
  ticketsClosed: 12,
  hours: 96,
  billableHours: 80,
  contributors: 5,
  overdue: 4,
  slaBreaches: 0,
  openEscalations: 0,
  changesRaised: 2,
  changesImplemented: 1,
  releases: 1,
  securityOpenCritical: 0,
  securityOpenHigh: 2,
  securityNewFindings: 1,
  trainingHours: 6,
  ...over
});

const initiative = (over: Partial<PracticeInitiative> = {}): PracticeInitiative => ({
  id: "p1",
  name: "Apollo",
  code: "APL",
  category: "PRODUCT",
  owner: "Mira Kapoor",
  status: "GREEN",
  ticketsCreated: 5,
  ticketsClosed: 4,
  openCount: 6,
  overdueCount: 0,
  hours: 38,
  progress: "4 closed · 5 raised · 38 h logged",
  risks: "",
  ...over
});

const data = (over: Partial<PracticeUpdateData> = {}): PracticeUpdateData => ({
  period: { from: "2026-08-17", to: "2026-08-23", label: "17 Aug – 23 Aug 2026" },
  previous: { from: "2026-08-10", to: "2026-08-16" },
  metrics: metrics(),
  previousMetrics: metrics({ ticketsClosed: 8, overdue: 9 }),
  initiatives: [initiative()],
  releases: [],
  isEmpty: false,
  ...over
});

describe("buildPracticeUpdateEmail — with no narrative at all", () => {
  it("still produces every section, from the counted figures", () => {
    const email = buildPracticeUpdateEmail(data(), null);

    expect(email.subject).toBe("Weekly AI/ML Practice Update — 17 Aug – 23 Aug 2026");
    for (const heading of ["Executive Summary", "Key Metrics", "Risks / Blockers", "Next Week Priorities", "Decisions / Support Required"]) {
      expect(email.sectionsHtml).toContain(heading);
    }
    // The summary is real content, not an apology for the model being off.
    expect(email.headline).toContain("12 tickets closed");
  });

  it("says nothing is at risk when nothing is, rather than leaving the section blank", () => {
    const email = buildPracticeUpdateEmail(data(), null);
    expect(email.sectionsHtml).toContain("Nothing is overdue or breaching SLA in this period.");
  });

  it("names what is red when something is", () => {
    const email = buildPracticeUpdateEmail(
      data({ initiatives: [initiative({ status: "RED", overdueCount: 12, risks: "12 overdue · 3 SLA breaches" })] }),
      null
    );
    expect(email.sectionsHtml).toContain("12 overdue · 3 SLA breaches");
    expect(email.headline).toContain("Apollo");
  });

  it("carries a delta on every figure, not a bare number", () => {
    // "47" cannot answer "is this week normal", which is the question the update exists for.
    const email = buildPracticeUpdateEmail(data(), null);
    expect(email.sectionsHtml).toContain("12 (up from 8)");
    expect(email.sectionsHtml).toContain("4 (down from 9)");
  });

  it("omits a practice area that had nothing in it", () => {
    // Ten headings with five "nothing here" boxes under them is how a weekly update starts
    // getting deleted unread.
    const email = buildPracticeUpdateEmail(data(), null);
    expect(email.sectionsHtml).toContain("Products / Features");
    expect(email.sectionsHtml).not.toContain("Training / Capability Building");
  });
});

describe("buildPracticeUpdateEmail — with a narrative", () => {
  const narrative = {
    executiveSummary: "A quiet week with steady progress on Apollo.",
    risks: ["One dependency on the vendor API is unresolved."],
    nextWeekPriorities: ["Ship the reconciliation report."],
    decisionsRequired: [],
    nextSteps: [{ id: "p1", text: "Finish the invoice export." }]
  };

  it("prefers the written prose over the fallback", () => {
    const email = buildPracticeUpdateEmail(data(), narrative);
    expect(email.sectionsHtml).toContain("A quiet week with steady progress on Apollo.");
    expect(email.sectionsHtml).toContain("One dependency on the vendor API is unresolved.");
    expect(email.headline).toContain("A quiet week");
  });

  it("attaches each next step to its own initiative by ID", () => {
    // By id, not by name — a renamed project must not silently inherit another's next step.
    const email = buildPracticeUpdateEmail(data(), narrative);
    expect(email.sectionsHtml).toContain("Finish the invoice export.");
  });

  it("falls back per SECTION, so one empty list does not blank the others", () => {
    const email = buildPracticeUpdateEmail(data(), narrative);
    // `decisionsRequired` was empty, so that section shows the counted facts instead.
    expect(email.sectionsHtml).toContain("No decisions are being requested this period.");
    expect(email.sectionsHtml).toContain("Ship the reconciliation report.");
  });

  it("escapes anything the model wrote", () => {
    const email = buildPracticeUpdateEmail(data(), { ...narrative, executiveSummary: '<img src=x onerror="alert(1)">' });
    expect(email.sectionsHtml).not.toContain("<img");
    expect(email.sectionsHtml).toContain("&lt;img");
  });
});

describe("narrativeInputs", () => {
  it("gives the model the initiative IDs it is asked to key next steps by", () => {
    const inputs = narrativeInputs(data());
    expect(inputs.initiatives).toContain("(id p1)");
    expect(inputs.initiatives).toContain("[PRODUCT] Apollo");
  });

  it("describes an empty period honestly rather than as a blank prompt", () => {
    const inputs = narrativeInputs(data({ initiatives: [] }));
    expect(inputs.initiatives).toBe("(no active initiatives with activity this period)");
  });
});
