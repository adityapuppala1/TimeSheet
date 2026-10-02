/**
 * The console's organization dialog, for a workspace that is still on a trial.
 *
 * Setting a plan there converts the trial (the API clears its clock and reopens a lapsed one), so the
 * dialog says so BEFORE the operator saves — and offers the other thing a sales conversation ends in,
 * moving the trial's end date, only while the plan stays on the free tier.
 */
import { describe, expect, it } from "vitest";
import { endOfDayIso, hasLiveTrial, trialEditNote } from "../../src/utils/org-trial";

const trial = { planTier: "STARTER" as const, trialTier: "TEAM" as const, trialEndsAt: "2026-10-16T09:00:00.000Z", stripeSubscriptionId: null };

describe("hasLiveTrial", () => {
  it("is a trial while the clock is set and nobody pays — the API's own isConverted rule, inverted", () => {
    expect(hasLiveTrial(trial)).toBe(true);
    expect(hasLiveTrial({ ...trial, trialEndsAt: null })).toBe(false);
    expect(hasLiveTrial({ ...trial, planTier: "TEAM" })).toBe(false);
    expect(hasLiveTrial({ ...trial, trialTier: null })).toBe(false);
    expect(hasLiveTrial({ ...trial, stripeSubscriptionId: "sub_1" })).toBe(false);
  });
});

describe("trialEditNote", () => {
  it("warns that choosing a paid plan ends the trial", () => {
    expect(trialEditNote(trial, "TEAM")).toMatch(/^Setting a plan ends the trial/);
  });

  it("names the trial and its end while the plan stays free", () => {
    expect(trialEditNote(trial, "STARTER")).toMatch(/Team trial/);
  });

  it("says nothing for a workspace that is not on a trial", () => {
    expect(trialEditNote({ ...trial, trialEndsAt: null }, "TEAM")).toBeNull();
  });
});

describe("endOfDayIso", () => {
  it("turns a picked date into the last second of that day, in the operator's zone", () => {
    const iso = endOfDayIso("2026-10-30")!;
    const local = new Date(iso);
    expect([local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes()]).toEqual([2026, 10, 30, 23, 59]);
  });

  it("is null for an empty or malformed value", () => {
    expect(endOfDayIso("")).toBeNull();
    expect(endOfDayIso("not-a-date")).toBeNull();
  });
});
