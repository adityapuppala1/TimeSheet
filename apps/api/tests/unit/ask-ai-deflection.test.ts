/**
 * The guard that stops Ask AI answering a question about somebody's own data without reading any
 * of it.
 *
 * THE BUG THIS EXISTS FOR, reported from a real workspace. Asked "where did my hours go over the
 * last two weeks?", the assistant replied — on the first step, having called nothing — that the
 * person could open the Timesheets tab, pick their name and use the date filters. Every word true,
 * and completely useless: `my_timesheets` was in its tool list and the prompt routes that exact
 * phrasing to it. The loop accepted the reply because an "answer" action was always terminal,
 * regardless of whether a single fact behind it came from the workspace.
 *
 * The predicate below is the whole fix, so these are the cases worth pinning: it fires once, only
 * when nothing was consulted, and never on the last step. The generosity is deliberate on the
 * other side too — a legitimate refusal of a general-knowledge question is allowed to repeat
 * itself and be accepted, which is why the answer is accepted unconditionally the second time
 * rather than being pushed again.
 */
import { describe, expect, it, vi } from "vitest";

// The loop lives in ai.service, which drags the provider SDKs and the env schema in with it. The
// predicate needs none of that, so the heavy edges are stubbed and only the pure function is read.
vi.mock("../../src/config/prisma.js", () => ({ prisma: {} }));

const { shouldPushBackForNoTools, looksLikeStall, ASK_OUT_OF_SCOPE } = await import("../../src/services/ai.service.js");

const MAX = 5;

describe("pushing back on an answer that consulted nothing", () => {
  it("fires on a first answer with no tool calls — the reported bug", () => {
    expect(shouldPushBackForNoTools({ toolCallCount: 0, alreadyNudged: false, step: 0, maxSteps: MAX })).toBe(true);
  });

  it("leaves an answer alone once ANY tool has been consulted", () => {
    // One tool result is enough to make the reply grounded. A short answer built on real data is
    // not the failure mode — an eloquent one built on none of it is.
    expect(shouldPushBackForNoTools({ toolCallCount: 1, alreadyNudged: false, step: 1, maxSteps: MAX })).toBe(false);
  });

  it("pushes back exactly once, however stubborn the model is", () => {
    // The second reply is accepted whatever it says. Without this the loop would spend every step
    // arguing with a model that has decided the question is unanswerable, and end with nothing.
    expect(shouldPushBackForNoTools({ toolCallCount: 0, alreadyNudged: true, step: 1, maxSteps: MAX })).toBe(false);
  });

  it("never spends the last step on a nudge", () => {
    // On the final step there is no room left to act on the correction, so a thin answer beats an
    // exhausted loop with no answer at all.
    expect(shouldPushBackForNoTools({ toolCallCount: 0, alreadyNudged: false, step: MAX - 1, maxSteps: MAX })).toBe(false);
  });

  it("still fires on the second-to-last step, where there IS room to act", () => {
    expect(shouldPushBackForNoTools({ toolCallCount: 0, alreadyNudged: false, step: MAX - 2, maxSteps: MAX })).toBe(true);
  });
});

describe("spotting a reply that announces a lookup instead of reporting one", () => {
  it("catches the measured case", () => {
    // Verbatim from a real run: search_tickets had already returned the rows.
    expect(looksLikeStall("Let me look up your ticket assignments.")).toBe(true);
  });

  it.each([
    "I'll check that for you.",
    "One moment while I gather the details.",
    "Looking into your timesheets now.",
    "I am going to search the tickets."
  ])("catches %j", (text) => {
    expect(looksLikeStall(text)).toBe(true);
  });

  it("leaves a short answer that actually reports something", () => {
    // No announcement opener — it states a finding, which is the whole point.
    expect(looksLikeStall("3 tickets are assigned to you: 2 open, 1 in review.")).toBe(false);
    expect(looksLikeStall("You logged 8.5 hours across one approved entry.")).toBe(false);
  });

  it("leaves a LONG answer alone even when it opens like an announcement", () => {
    // The length cap is what stops this rewriting good prose. A real answer that happens to begin
    // "I'll summarise" has already done the work; only a stub is worth another call.
    const long = `I'll summarise what the tools returned. ${"Ticket HICS-TS-3 is open and assigned to you. ".repeat(4)}`;
    expect(long.length).toBeGreaterThan(160);
    expect(looksLikeStall(long)).toBe(false);
  });

  it("is not fooled by leading whitespace", () => {
    expect(looksLikeStall("   \n  Let me fetch that.")).toBe(true);
  });
});

describe("the out-of-scope refusal", () => {
  /*
   * This string exists because the model wrote its own and got it wrong. Asked for the capital of
   * France it declined politely and then offered to "look up the knowledge base or search the
   * internet" — two capabilities this product does not have. A refusal that invents abilities is
   * worse than no refusal, because the next question is the person trying to use one.
   */
  it("offers nothing the product cannot do", () => {
    /*
     * The banned strings are OFFERS, not topics. An earlier version of this test forbade the bare
     * phrase "search the web", which also forbade the honest denial of it in the very next
     * assertion — the two could not both pass. What matters is that nothing here reads as an
     * ability: "I can search…", "let me look it up…", a knowledge base that does not exist.
     */
    const lowered = ASK_OUT_OF_SCOPE.toLowerCase();
    for (const offer of [
      "i can search",
      "i could search",
      "let me search",
      "let me look it up",
      "knowledge base",
      "i can browse",
      "on the internet for you"
    ]) {
      expect(lowered).not.toContain(offer);
    }
  });

  it("says plainly that there is no outside source", () => {
    expect(ASK_OUT_OF_SCOPE.toLowerCase()).toContain("no way to search the web");
  });

  it("names what IS in scope, so the refusal is a redirection rather than a dead end", () => {
    const lowered = ASK_OUT_OF_SCOPE.toLowerCase();
    for (const noun of ["tickets", "timesheets", "changes", "projects"]) {
      expect(lowered).toContain(noun);
    }
  });
});
