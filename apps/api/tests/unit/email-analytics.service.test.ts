/**
 * Pins the two pure pieces of the email analytics read model.
 *
 * `resolveLogTemplate` is the whole reason that service exists: `EmailLog.template` holds a
 * notification CATEGORY for worker-driven sends and a templateKey for transactional ones, so the
 * mapping back to a template card is hand-maintained. A silent regression here does not throw —
 * it just moves counts onto the wrong card or drops them into "unmapped", which is exactly the
 * kind of quiet wrongness a dashboard cannot self-report.
 *
 * `normalizeErrorMessage` is the grouping key for failure debugging. Under-normalising splits one
 * misconfiguration into hundreds of one-off rows; over-normalising merges genuinely different
 * SMTP rejections, so both directions are pinned.
 */
import { describe, expect, it } from "vitest";
import { normalizeErrorMessage, resolveLogTemplate } from "../../src/services/email-analytics.service.js";

describe("resolveLogTemplate", () => {
  it("maps a category that is spelled like its template key straight through", () => {
    expect(resolveLogTemplate("timesheet.approved")).toEqual({ cards: ["timesheet.approved"], isTest: false });
  });

  it("maps a transactional templateKey that has no category at all", () => {
    expect(resolveLogTemplate("welcome")).toEqual({ cards: ["welcome"], isTest: false });
  });

  it("routes the enrollment REMINDER category onto the enrollment REQUIRED card", () => {
    expect(resolveLogTemplate("face.enrollment_reminder")).toEqual({ cards: ["face.enrollment_required"], isTest: false });
  });

  it("attributes the one escalation category to both templates it can produce", () => {
    expect(resolveLogTemplate("reminder.escalation").cards).toEqual([
      "reminder.escalation.employee",
      "reminder.escalation.manager"
    ]);
  });

  it("flags editor test sends and still resolves them to their card", () => {
    expect(resolveLogTemplate("welcome.test")).toEqual({ cards: ["welcome"], isTest: true });
  });

  it("returns no card for a category with a code-only email, so it lands in the unmapped bucket", () => {
    // digest.bug_pattern and ticket.stale_nudge are real NotificationCategory values with no
    // editable template — they must be reported, never silently dropped.
    expect(resolveLogTemplate("digest.bug_pattern").cards).toEqual([]);
    expect(resolveLogTemplate("ticket.stale_nudge").cards).toEqual([]);
    expect(resolveLogTemplate("ad-hoc").cards).toEqual([]);
  });
});

describe("normalizeErrorMessage", () => {
  it("groups the same rejection for different recipients", () => {
    const a = normalizeErrorMessage("550 5.1.1 <aanya@example.com>: Recipient address rejected: User unknown");
    const b = normalizeErrorMessage("550 5.1.1 <dev@example.com>: Recipient address rejected: User unknown");
    expect(a).toBe(b);
    // The SMTP status codes are the signal and must survive normalisation.
    expect(a).toContain("550 5.1.1");
  });

  it("strips volatile queue ids, hosts and timestamps", () => {
    const a = normalizeErrorMessage("451 4.3.0 queued as 4Gq3Yz1234z from 10.0.11.4 at 2026-08-07T10:22:31Z");
    const b = normalizeErrorMessage("451 4.3.0 queued as 7Hb9Xw5678q from 10.0.11.9 at 2026-08-06T02:04:09Z");
    expect(a).toBe(b);
  });

  it("keeps genuinely different rejections apart", () => {
    expect(normalizeErrorMessage("535 5.7.8 Authentication credentials invalid")).not.toBe(
      normalizeErrorMessage("550 5.7.1 Message rejected as spam")
    );
  });

  it("collapses Gmail's compound session token INCLUDING its ordinal suffix", () => {
    // The real-world shape that motivated this: identical 421 throttles were splitting into one
    // group per `.N` because the two token halves normalise to <id> but the joiner and ordinal
    // survived — `<id>-<id>.2` vs `<id>-<id>.6` are different strings.
    const a = normalizeErrorMessage(
      "Data command failed: 421-4.3.0 Temporary System Problem. Try again later. For more information, go to 421 4.3.0 https://support.google.com/a/answer/3221692 a1b2c3d4e5-f6a7b8c9d0.2 - gsmtp"
    );
    const b = normalizeErrorMessage(
      "Data command failed: 421-4.3.0 Temporary System Problem. Try again later. For more information, go to 421 4.3.0 https://support.google.com/a/answer/3221692 e5d4c3b2a1-x9y8z7w6v5.6 - gsmtp"
    );
    expect(a).toBe(b);
    // The SMTP status code is the signal and must survive the compound-id collapse untouched.
    expect(a).toContain("421-4.3.0");
    expect(a).toContain("421 4.3.0");
  });

  it("collapses whitespace and caps runaway multi-line SMTP transcripts", () => {
    expect(normalizeErrorMessage("  550   line one\n  line two  ")).toBe("550 line one line two");
    expect(normalizeErrorMessage("x".repeat(1000)).length).toBe(300);
  });
});
