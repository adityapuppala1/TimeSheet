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
import type { PracticeAnalytics } from "../../src/services/practice-analytics.service.js";
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
  criticalOpen: 0,
  highOpen: 0,
  nextDueDate: null,
  progress: "4 closed · 5 raised · 38 h logged",
  risks: "",
  ...over
});

/**
 * The derived layer, defaulting to "nothing measured".
 *
 * NULLS RATHER THAN ZEROES IN THE BASELINE, on purpose: a fixture full of zeroes would let a
 * rendering bug that prints "0%" for an unmeasured rate pass every test in this file. Each test
 * that cares about a rate sets it explicitly.
 */
const analytics = (over: Partial<PracticeAnalytics> = {}): PracticeAnalytics => ({
  delivery: {
    closureRatePct: null,
    onTimeClosurePct: null,
    closedWithDueDate: 0,
    medianCycleHours: null,
    reopened: 0,
    everResolved: 0,
    reopenRatePct: null,
    unassignedOpen: 0,
    backlogOpen: 6,
    dueNextWeek: 0
  },
  priority: { criticalOpen: 0, highOpen: 0, criticalClosed: 0, highClosed: 0, criticalOverdue: 0 },
  quality: {
    testRuns: 0,
    runsPassed: 0,
    runsFailed: 0,
    testsPassed: 0,
    testsFailed: 0,
    runPassRatePct: null,
    testPassRatePct: null,
    gatesPassed: 0,
    gatesWarned: 0,
    gatesFailed: 0
  },
  security: {
    verifiedFixed: 0,
    awaitingVerification: 0,
    scanRuns: 0,
    newCritical: 0,
    newHigh: 0,
    medianOpenAgeDays: null,
    oldestOpenDays: null
  },
  change: {
    successful: 0,
    withIssues: 0,
    failed: 0,
    rolledBack: 0,
    successRatePct: null,
    outcomeRecorded: 0,
    emergency: 0,
    awaitingApproval: 0,
    scheduledNextWeek: 0
  },
  people: { topContributors: [], utilisationPct: null, capacityHours: null, billablePct: null, silentOwners: 0 },
  poc: { started: 0, ongoing: 0, completed: 0, hours: 0 },
  goals: { active: 0, achievedThisPeriod: 0, overdue: 0 },
  ai: { agentRuns: 0, agentRunsFailed: 0, interactions: 0, spendUsd: null },
  ...over
});

const data = (over: Partial<PracticeUpdateData> = {}): PracticeUpdateData => ({
  period: { from: "2026-08-17", to: "2026-08-23", label: "17 Aug – 23 Aug 2026" },
  previous: { from: "2026-08-10", to: "2026-08-16" },
  metrics: metrics(),
  previousMetrics: metrics({ ticketsClosed: 8, overdue: 9 }),
  initiatives: [initiative()],
  analytics: analytics(),
  previousAnalytics: analytics(),
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

  it("strips anything the model wrote that isn't allowed rich text", () => {
    /*
     * This used to assert the summary was ESCAPED — `&lt;img` appearing in the output. That was
     * right while the written sections were plain strings. They are rich text now (the reviewer
     * edits them in a real editor and the email renders headings, bold and lists), so the summary
     * is SANITISED instead: a disallowed tag is removed rather than shown to the reader as text.
     *
     * The guarantee is the same or stronger — nothing dangerous reaches the recipient either way —
     * and the change is deliberate. What would be a regression is `<img` surviving, which is what
     * the first assertion still pins.
     */
    const email = buildPracticeUpdateEmail(data(), { ...narrative, executiveSummary: '<p>Fine.</p><img src=x onerror="alert(1)">' });
    expect(email.sectionsHtml).not.toContain("<img");
    expect(email.sectionsHtml).not.toContain("onerror");
    // The legitimate prose beside it still arrives, rendered rather than escaped.
    expect(email.sectionsHtml).toContain("Fine.");
    expect(email.sectionsHtml).not.toContain("&lt;p&gt;");
  });
});

/**
 * The rendering half of the honesty rule.
 *
 * `practice-analytics.service.ts` is careful to return `null` for a rate whose denominator was
 * zero — and every bit of that care is undone by one template that prints `${value}%` anyway. This
 * block was written because a deliberate break that made the email print "0%" for an unmeasured
 * rate passed the entire analytics suite: the service was right and the reader would still have
 * been told the team delivered nothing on time in a week where nothing had a deadline.
 */
/**
 * Reads the VALUE cell for one Key Metrics row, tags stripped.
 *
 * Scoped deliberately: an earlier version of these tests asserted `not.toContain("0%")` against the
 * whole document and failed on the `width="100%"` in the table markup — a test that was wrong about
 * code that was right, which is the most expensive kind. Asking for one row's value keeps the
 * assertion about the thing being tested.
 */
function metricValue(html: string, label: string): string {
  const at = html.indexOf(`>${label}</td>`);
  if (at === -1) throw new Error(`no Key Metrics row labelled "${label}"`);
  const rest = html.slice(at);
  const cell = /<td[^>]*>([^<]*)<\/td>/.exec(rest.slice(rest.indexOf("</td>") + 5));
  return (cell?.[1] ?? "").replace(/&amp;/g, "&").trim();
}

describe("an unmeasured rate never renders as a number", () => {
  it("prints a dash, and says what the denominator was", () => {
    const html = buildPracticeUpdateEmail(data(), null).sectionsHtml;

    // The baseline fixture leaves every rate null. "0%" here would tell a director the team
    // delivered nothing on time in a week where nothing had a deadline.
    expect(metricValue(html, "Closure rate (closed ÷ raised)")).toBe("—");
    expect(metricValue(html, "Delivered on time")).toBe("— (0 had a due date)");
    expect(metricValue(html, "Billable share of hours")).toBe("—");
    expect(metricValue(html, "Utilisation against capacity")).toBe("— (no capacity on file)");
  });

  it("prints the figure once there is something to divide by", () => {
    const html = buildPracticeUpdateEmail(
      data({
        analytics: analytics({
          delivery: { ...analytics().delivery, closureRatePct: 80, onTimeClosurePct: 50, closedWithDueDate: 4 }
        })
      }),
      null
    ).sectionsHtml;

    expect(metricValue(html, "Closure rate (closed ÷ raised)")).toBe("80%");
    expect(metricValue(html, "Delivered on time")).toBe("50% (4 had a due date)");
  });

  it("reports a rate's movement in POINTS, not as a percentage of a percentage", () => {
    // 40% to 50% is a rise of ten points. Reporting it as "+25%" is how a modest week gets
    // described to a director as a transformation.
    const html = buildPracticeUpdateEmail(
      data({
        analytics: analytics({ delivery: { ...analytics().delivery, closureRatePct: 50 } }),
        previousAnalytics: analytics({ delivery: { ...analytics().delivery, closureRatePct: 40 } })
      }),
      null
    ).sectionsHtml;

    expect(metricValue(html, "Closure rate (closed ÷ raised)")).toBe("50% (+10 pts)");
  });
});

describe("the counted fallbacks name blockers nobody owns", () => {
  it("raises unassigned work and unproven security fixes without a model", () => {
    const html = buildPracticeUpdateEmail(
      data({
        analytics: analytics({
          delivery: { ...analytics().delivery, unassignedOpen: 7, closureRatePct: 60 },
          priority: { ...analytics().priority, criticalOverdue: 2 },
          security: { ...analytics().security, awaitingVerification: 3 }
        })
      }),
      null
    ).sectionsHtml;

    // None of these belong to a single initiative, so no initiative row would have carried them.
    expect(html).toContain("2 critical tickets are past SLA");
    expect(html).toContain("7 open tickets have no assignee");
    expect(html).toContain("The backlog grew");
    expect(html).toContain("claimed but not yet proven");
  });

  it("asks for decisions, not for effort", () => {
    const html = buildPracticeUpdateEmail(
      data({
        analytics: analytics({
          change: { ...analytics().change, awaitingApproval: 2 },
          people: { ...analytics().people, utilisationPct: 118 }
        })
      }),
      null
    ).sectionsHtml;

    // Both are things only somebody with authority can settle. Work in progress is deliberately
    // absent from this section — a decisions list that fills up with status stops being read.
    expect(html).toContain("2 changes are waiting on approval");
    expect(html).toContain("118% of capacity");
  });
});

/**
 * A DRAFT STORED BEFORE THE ANALYTICS LAYER EXISTED STILL HAS TO RENDER.
 *
 * `PracticeUpdateRecord.data` is a JSON column, and the controller replays it with a bare
 * `record.data as unknown as PracticeUpdateData` — a cast, which checks nothing at runtime. Every
 * draft and every history row written before this release lacks `analytics`, so the moment the
 * email started reading `data.analytics.priority` those rows became a 500 on:
 *   - GET /practice-update/draft — the page a super admin opens
 *   - the history detail view
 *   - the send preview
 *
 * Nothing would have caught it: the type says the field is there, and every fixture in this file
 * provides it. This block is the fixture that does not.
 */
describe("a draft stored before this release still renders", () => {
  const legacy = () => {
    const complete = data() as unknown as Record<string, unknown>;
    const { analytics: _a, previousAnalytics: _p, ...withoutAnalytics } = complete;
    return withoutAnalytics as unknown as PracticeUpdateData;
  };

  it("renders the whole email rather than throwing", () => {
    const email = buildPracticeUpdateEmail(legacy(), null);

    expect(email.subject).toContain("Weekly AI/ML Practice Update");
    // Every section still arrives — the derived rows are what degrade, not the document.
    for (const heading of ["Executive Summary", "Key Metrics", "Risks / Blockers", "Decisions / Support Required"]) {
      expect(email.sectionsHtml).toContain(heading);
    }
    // And the counted figures the old draft DOES carry are still printed.
    expect(email.sectionsHtml).toContain("Tickets closed");
  });

  it("shows the missing derived figures as unmeasured, never as zero", () => {
    const html = buildPracticeUpdateEmail(legacy(), null).sectionsHtml;
    // An old draft genuinely does not know its closure rate. Printing 0% would be inventing one.
    expect(metricValue(html, "Closure rate (closed ÷ raised)")).toBe("—");
  });

  it("still builds the model's prompt from what the old draft does have", () => {
    const inputs = narrativeInputs(legacy());
    expect(inputs.metrics).toContain("DELIVERY");
    expect(inputs.metrics).toContain("not measured");
  });

  it("never prints the word undefined into a leadership email", () => {
    // The initiatives inside an old draft carry no severity split either. `undefined + undefined`
    // is NaN, and `NaN === 0` is false — so the guard that was meant to hide the sub-line let it
    // through, and the row rendered "undefined crit · undefined high" to a CEO.
    const stale = data() as unknown as Record<string, unknown>;
    const { analytics: _a, previousAnalytics: _p, ...withoutAnalytics } = stale;
    const initiativeRow = initiative({ openCount: 8 }) as unknown as Record<string, unknown>;
    delete initiativeRow.criticalOpen;
    delete initiativeRow.highOpen;
    delete initiativeRow.nextDueDate;

    const html = buildPracticeUpdateEmail(
      { ...withoutAnalytics, initiatives: [initiativeRow] } as unknown as PracticeUpdateData,
      null
    ).sectionsHtml;

    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });
});

/**
 * TWO SLA QUEUES, AND THE REPORT MUST NOT LET THEM BE ADDED TOGETHER.
 *
 * `PracticeMetrics.slaBreaches` counts TIMESHEET APPROVALS past their SLA. `metrics.overdue` counts
 * TICKETS past theirs. They were rendered adjacently, both labelled as SLA breaches, in a table
 * otherwise entirely about tickets — so a reader took the smaller number to be tickets. On the dev
 * workspace they differ by an order of magnitude (23 approvals against 320 tickets), and the
 * approvals figure ALSO forces an initiative red, so a project went red for a late approval queue
 * inside a row that never mentions approvals.
 *
 * The field name is deliberately unchanged: it is persisted inside `PracticeUpdateRecord.data`, and
 * renaming it would make every stored draft and history row read `undefined` — the same bug this
 * file already guards against for `analytics`. What is pinned here is that every LABEL says which
 * queue it means.
 */
describe("the two SLA queues are never labelled the same", () => {
  it("names the approvals queue as approvals, everywhere it surfaces", () => {
    const html = buildPracticeUpdateEmail(data({ metrics: metrics({ slaBreaches: 4, overdue: 11 }) }), null).sectionsHtml;

    expect(metricValue(html, "Timesheet approvals past SLA")).toContain("4");
    // The bare phrase is what a reader mistook for tickets.
    expect(html).not.toContain(">SLA breaches</td>");
  });

  it("tells the model they are different queues, so it cannot sum them", () => {
    const inputs = narrativeInputs(data({ metrics: metrics({ slaBreaches: 4, overdue: 11 }) }));

    expect(inputs.metrics).toContain("Tickets past SLA");
    expect(inputs.metrics).toContain("Timesheet approvals past SLA");
    expect(inputs.metrics).toContain("do not add them together");
  });

  it("says WHY an initiative is red, in the words of the queue that made it red", () => {
    // A red nobody can explain in the meeting is worse than no red at all.
    const html = buildPracticeUpdateEmail(
      data({ initiatives: [initiative({ status: "RED", risks: "2 approvals past SLA" })] }),
      null
    ).sectionsHtml;

    expect(html).toContain("2 approvals past SLA");
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

  it("tells the model a rate was NOT MEASURED rather than handing it a zero", () => {
    // A model given "0%" will faithfully write a sentence about a failure that did not happen, and
    // that sentence goes to a director under the team's name.
    const inputs = narrativeInputs(data());
    expect(inputs.metrics).toContain("not measured");
    expect(inputs.metrics).not.toMatch(/Closure rate[^\n]*: 0%/);
  });

  it("gives the model the ratios and ages, not only the counts it could already see", () => {
    const inputs = narrativeInputs(
      data({
        analytics: analytics({
          delivery: { ...analytics().delivery, closureRatePct: 78, backlogOpen: 40 },
          security: { ...analytics().security, medianOpenAgeDays: 63, oldestOpenDays: 120 },
          people: { ...analytics().people, utilisationPct: 91, capacityHours: 200 }
        })
      })
    );

    // The three sentences worth having are built on these, and none is visible in a raw count.
    expect(inputs.metrics).toContain("78%");
    expect(inputs.metrics).toContain("median 63 days");
    expect(inputs.metrics).toContain("91%");
    // And the block labels, so the model can tell delivery figures from security ones.
    expect(inputs.metrics).toContain("DELIVERY");
    expect(inputs.metrics).toContain("SECURITY");
  });
});
