/**
 * The outbound email queue — the retry policy, and the classification that decides whether a
 * failure earns one.
 *
 * WHY IT EXISTS: `EmailLog` carried a QUEUED status from the first migration and nothing ever
 * re-drove a row out of it. `sendMail` wrote QUEUED, hit the SMTP server in the same breath, and
 * wrote SENT or FAILED — so a provider answering "451 too many messages, slow down" lost that
 * email permanently. And because notifications dispatch detached, a bulk approval fired one
 * connection per message at once, which is what earns the 451 to begin with.
 *
 * The two rules worth pinning are the ones that are easy to get backwards, and expensive both
 * ways: retrying a permanent rejection forever damages the sending reputation the queue depends
 * on, and giving up on a transient one silently drops mail somebody is waiting for.
 */
import { describe, expect, it } from "vitest";
import { classifyFailure, looksSensitive, MAX_SEND_ATTEMPTS, nextSendAttemptAt } from "../../src/services/mail.service.js";

/** nodemailer surfaces the SMTP reply verbatim on the thrown error. */
function smtpError(responseCode: number, message: string) {
  return Object.assign(new Error(message), { responseCode });
}

describe("classifyFailure", () => {
  it("retries a 4xx, which is what a rate limit actually looks like on the wire", () => {
    // RFC 5321: a 4xx reply is by definition "try again later".
    expect(classifyFailure(smtpError(451, "4.7.0 Too many messages, slow down")).retryable).toBe(true);
    expect(classifyFailure(smtpError(421, "Service not available, closing transmission channel")).retryable).toBe(true);
    expect(classifyFailure(smtpError(452, "Insufficient system storage")).retryable).toBe(true);
  });

  it("gives up on a permanent 5xx rather than hammering a dead address", () => {
    expect(classifyFailure(smtpError(550, "5.1.1 The email account does not exist")).retryable).toBe(false);
    expect(classifyFailure(smtpError(553, "Mailbox name not allowed")).retryable).toBe(false);
  });

  it("reads the text when the code alone is ambiguous", () => {
    // Several providers answer 550 for "sending quota exceeded", which IS transient — the code
    // says permanent and the sentence says otherwise, and the sentence is right.
    expect(classifyFailure(smtpError(550, "5.4.5 Daily sending quota exceeded")).retryable).toBe(true);
    expect(classifyFailure(smtpError(550, "Too many messages from this sender, try again later")).retryable).toBe(true);
  });

  it("retries a dropped socket — it says nothing about whether the message was acceptable", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ESOCKET"]) {
      expect(classifyFailure(Object.assign(new Error("socket hang up"), { code })).retryable, code).toBe(true);
    }
  });

  it("defaults an unrecognised failure to retryable", () => {
    // The attempt cap bounds the cost of being wrong here at four extra tries. The cost of the
    // opposite default is an email nobody ever finds out was dropped.
    expect(classifyFailure(new Error("something nobody has seen before")).retryable).toBe(true);
  });

  it("carries the provider's own words through, rather than a generic message", () => {
    // This string is what lands in EmailLog.errorMessage and in front of an admin trying to work
    // out why mail stopped. Replacing it with "send failed" throws away the only diagnosis.
    expect(classifyFailure(smtpError(535, "5.7.8 Username and Password not accepted")).reason).toContain(
      "Username and Password not accepted"
    );
  });
});

describe("nextSendAttemptAt", () => {
  const now = 1_760_000_000_000;

  it("backs off further on each attempt", () => {
    const delays = [1, 2, 3, 4].map((attempt) => nextSendAttemptAt(attempt, now).getTime() - now);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i], `attempt ${i + 1} must wait longer than attempt ${i}`).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("starts at about a minute and never schedules in the past", () => {
    const first = nextSendAttemptAt(1, now).getTime() - now;
    expect(first).toBeGreaterThanOrEqual(60_000);
    // Base plus at most 20% jitter.
    expect(first).toBeLessThanOrEqual(72_000);
  });

  it("jitters, so a burst rejected together does not come back in lockstep", () => {
    const samples = new Set(Array.from({ length: 40 }, () => nextSendAttemptAt(1, now).getTime()));
    expect(samples.size, "every retry landing on the same millisecond would re-create the burst").toBeGreaterThan(1);
  });

  it("clamps past the end of the schedule instead of indexing off it", () => {
    // `attempt` can reach MAX_SEND_ATTEMPTS; the delay table is shorter than that on purpose.
    const last = nextSendAttemptAt(MAX_SEND_ATTEMPTS, now).getTime() - now;
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBeGreaterThan(0);
  });

  it("gives up inside a bounded window rather than retrying forever", () => {
    const total = Array.from({ length: MAX_SEND_ATTEMPTS }, (_, i) => nextSendAttemptAt(i + 1, now).getTime() - now).reduce(
      (a, b) => a + b,
      0
    );
    // Long enough to outlast a provider's per-minute cap and a brief relay outage; short enough
    // that a genuinely undeliverable message surfaces as FAILED the same working day.
    expect(total).toBeLessThan(2 * 60 * 60 * 1000);
  });
});

/**
 * A credential in an email body must never reach the queue's `payload` column.
 *
 * THE REGRESSION THIS GUARDS: the retry queue keeps the rendered body on the row so a deferred
 * send has something to send. For a notification that is harmless. For a password-reset email it
 * is the LIVE token — hashed with bcrypt in `PasswordResetToken` precisely so that database
 * access does not yield a usable one — and storing the body would hand that straight back.
 *
 * `sensitive: true` is set explicitly at those call sites; `looksSensitive` is the safety net for
 * a future template that carries a secret and forgets to.
 */
describe("credential-bearing bodies are never persisted", () => {
  it("recognises a reset link, in whatever shape a template renders it", () => {
    for (const html of [
      '<a href="https://x.io/reset-password?token=abc123">Reset</a>',
      "<p>Open https://acme.timesphere.app/reset-password?token=9f8e7d6c5b4a to continue</p>",
      '<a href="https://x.io/verify?token=aVeryLongOpaqueTokenValue123">Verify</a>'
    ]) {
      expect(looksSensitive(html), html).toBe(true);
    }
  });

  it("recognises a handed-out password", () => {
    expect(looksSensitive("<p>Your one-time password is <b>Hx7k2Qp9!7a</b></p>")).toBe(true);
    expect(looksSensitive("<p>Sign in with this temporary password: Hx7k2Qp9!7a</p>")).toBe(true);
  });

  it("leaves ordinary notification mail alone, so the queue keeps retrying what it should", () => {
    // A false positive costs one un-retried email; a blanket "treat everything as sensitive"
    // would silently disable the whole retry feature, which is the thing being built.
    for (const html of [
      "<p>Your 3.50h entry for 2026-08-13 on Apollo was approved.</p>",
      '<a href="https://x.io/app/history">Open your timesheet</a>',
      "<p>WEB-12 was assigned to you. Due Friday.</p>"
    ]) {
      expect(looksSensitive(html), html).toBe(false);
    }
  });
});
