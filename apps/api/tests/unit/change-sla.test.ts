/**
 * WHAT: the stage-clock judgement behind the SLA ladder and the "SLA breached" tile.
 *
 * WHY THESE CASES: the interesting behaviour is not "is it late" — it is the distinction between a
 * clock that is STILL RUNNING and one that has STOPPED. A stage that finished late is a breach that
 * already happened, and the tempting implementation reports it as fine the moment it closes, because
 * "now" is no longer past the due date. That is how an SLA dashboard comes to say everything is
 * green while the register is full of overruns, so it is the first thing pinned here.
 */
import { describe, expect, it } from "vitest";
import { judgeChangeSlas, judgeSla } from "../../src/services/change.service.js";

const HOUR = 3600 * 1000;
const at = (hoursFromEpoch: number) => new Date(hoursFromEpoch * HOUR);
const CONFIG = { hours: 48, warnAtPct: 75 };

describe("judgeSla", () => {
  it("has no verdict for a stage that never started", () => {
    expect(judgeSla(null, null, CONFIG, at(100)).state).toBe("NOT_STARTED");
  });

  it("has no verdict when the stage is not configured, rather than treating it as instantly breached", () => {
    // A disabled stage has no clock. Defaulting to zero hours would breach everything on sight.
    expect(judgeSla(at(0), null, null, at(100)).state).toBe("NOT_STARTED");
    expect(judgeSla(at(0), null, { hours: 0, warnAtPct: 75 }, at(100)).state).toBe("NOT_STARTED");
  });

  it("counts a running clock against now", () => {
    expect(judgeSla(at(0), null, CONFIG, at(12)).state).toBe("ON_TRACK");
    expect(judgeSla(at(0), null, CONFIG, at(12)).hoursRemaining).toBe(36);
  });

  it("warns at the configured fraction, not at the deadline", () => {
    // 75% of 48h is 36h. One hour short is still on track; one hour past is a warning.
    expect(judgeSla(at(0), null, CONFIG, at(35)).state).toBe("ON_TRACK");
    expect(judgeSla(at(0), null, CONFIG, at(37)).state).toBe("WARNING");
  });

  it("breaches a running clock once the budget is spent, and reports how far over", () => {
    const verdict = judgeSla(at(0), null, CONFIG, at(57));
    expect(verdict.state).toBe("BREACHED");
    expect(verdict.hoursRemaining).toBe(-9);
  });

  it("judges a FINISHED stage on how long it actually took, not on where the clock is now", () => {
    // The regression this file exists for. The stage ran 60h against a 48h budget and then closed;
    // "now" is a week later. Judging against now would call it fine.
    const late = judgeSla(at(0), at(60), CONFIG, at(200));
    expect(late.state).toBe("BREACHED");
    expect(late.hoursRemaining).toBe(-12);

    const onTime = judgeSla(at(0), at(20), CONFIG, at(200));
    expect(onTime.state).toBe("MET");
  });

  it("never reports a finished stage as WARNING — there is nothing left to save", () => {
    // 40h of a 48h budget is past the 75% warning line, but the stage is over.
    expect(judgeSla(at(0), at(40), CONFIG, at(200)).state).toBe("MET");
  });

  it("clamps the progress bar rather than letting a long overrun draw off the end", () => {
    expect(judgeSla(at(0), null, CONFIG, at(500)).pctElapsed).toBe(100);
    expect(judgeSla(at(0), null, CONFIG, at(-5)).pctElapsed).toBe(0);
  });
});

describe("judgeChangeSlas", () => {
  const config = { APPROVAL: CONFIG, IMPLEMENTATION: CONFIG, VALIDATION: CONFIG, CLOSURE: CONFIG };

  it("returns the full ladder even where a stage has not started", () => {
    const verdicts = judgeChangeSlas(
      { state: "AWAITING_APPROVAL", submittedAt: at(0), approvedAt: null, actualStart: null, actualEnd: null, closedAt: null },
      config,
      at(10)
    );
    // All four keys present: "approval running, the rest not started" is more useful to read than
    // three rows that appear one at a time.
    expect(Object.keys(verdicts).sort()).toEqual(["APPROVAL", "CLOSURE", "IMPLEMENTATION", "VALIDATION"]);
    expect(verdicts.APPROVAL.state).toBe("ON_TRACK");
    expect(verdicts.IMPLEMENTATION.state).toBe("NOT_STARTED");
  });

  it("advances the ladder as the change moves", () => {
    const verdicts = judgeChangeSlas(
      { state: "IMPLEMENTING", submittedAt: at(0), approvedAt: at(10), actualStart: at(12), actualEnd: null, closedAt: null },
      config,
      at(20)
    );
    expect(verdicts.APPROVAL.state).toBe("MET");
    expect(verdicts.IMPLEMENTATION.state).toBe("ON_TRACK");
    expect(verdicts.VALIDATION.state).toBe("NOT_STARTED");
    expect(verdicts.CLOSURE.state).toBe("ON_TRACK");
  });

  it("stops the closure clock when the change closes", () => {
    const verdicts = judgeChangeSlas(
      { state: "CLOSED", submittedAt: at(0), approvedAt: at(10), actualStart: at(12), actualEnd: at(14), closedAt: at(20) },
      config,
      at(9999)
    );
    expect(verdicts.CLOSURE.state).toBe("MET");
    expect(verdicts.IMPLEMENTATION.state).toBe("MET");
  });
});
