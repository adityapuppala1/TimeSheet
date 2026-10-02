/**
 * The line on the email-intake settings that says how much mail the loop guard dropped.
 *
 * A drop used to leave only a server console line, so when the guard misfired — it discarded every
 * customer message relayed through a Google Group — nobody running the workspace could tell. The API
 * now returns a running count and the latest drop's reason; this decides whether and how to say it.
 */
import { describe, expect, it } from "vitest";

import { automatedDropsNote } from "../../src/lib/email-intake-status";

describe("automatedDropsNote", () => {
  it("says nothing when nothing was dropped, or when an older server sends no count", () => {
    expect(automatedDropsNote(undefined)).toBeNull();
    expect(automatedDropsNote({ count: 0, lastReason: null, lastFrom: null, lastAt: null })).toBeNull();
  });

  it("names the count and the latest drop's reason and sender", () => {
    const note = automatedDropsNote({ count: 3, lastReason: "Auto-Submitted: auto-replied", lastFrom: "ooo@vendor.test", lastAt: null });
    expect(note).toBe("3 automated messages skipped (auto-replies, bounces and bulk mail never become tickets). Latest: Auto-Submitted: auto-replied, from ooo@vendor.test.");
  });

  it("uses the singular for one message", () => {
    expect(automatedDropsNote({ count: 1, lastReason: "a null return path", lastFrom: null, lastAt: null })).toBe(
      "1 automated message skipped (auto-replies, bounces and bulk mail never become tickets). Latest: a null return path."
    );
  });
});
