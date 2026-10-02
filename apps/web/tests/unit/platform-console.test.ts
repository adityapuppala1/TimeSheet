/**
 * The console's small decisions that have to agree with the server: which account gate an operator
 * is behind, and how a gated 403 is recognised so the console can route to the form that lifts it.
 */
import { describe, expect, it } from "vitest";
import { accountGateFromError, consoleAccountGate, isQueuedForApproval, shouldNagForMfa } from "../../src/lib/platform-console";

describe("isQueuedForApproval — a 202 is not a success", () => {
  it("recognises the two-person queue's answer", () => {
    expect(isQueuedForApproval({ pending: true, requestId: "r-1", message: "Queued for approval." })).toBe(true);
  });

  it("does not mistake a completed result for one", () => {
    expect(isQueuedForApproval({ restored: true, slug: "acme" })).toBe(false);
    expect(isQueuedForApproval({ deleted: true, id: "x.sql" })).toBe(false);
    expect(isQueuedForApproval({ enabled: true, retentionDays: 90 })).toBe(false);
    expect(isQueuedForApproval(null)).toBe(false);
  });
});

describe("consoleAccountGate", () => {
  it("is the password form while the server says the password must change", () => {
    expect(consoleAccountGate({ mustChangePassword: true })).toBe("password");
  });

  it("is enrolment while the deployment requires a factor this operator lacks", () => {
    expect(consoleAccountGate({ mustChangePassword: false, mfaEnrolmentRequired: true })).toBe("mfa");
  });

  it("puts the password first, as the server does", () => {
    expect(consoleAccountGate({ mustChangePassword: true, mfaEnrolmentRequired: true })).toBe("password");
  });

  it("is nothing for an ordinary signed-in operator", () => {
    expect(consoleAccountGate({ mustChangePassword: false })).toBeNull();
    expect(consoleAccountGate(undefined)).toBeNull();
  });
});

describe("shouldNagForMfa — the banner for operators the deployment does not force", () => {
  it("nags an operator with no factor when nothing else is in the way", () => {
    expect(shouldNagForMfa({ mfaEnabled: false, mfaEnrolmentRequired: false, mustChangePassword: false })).toBe(true);
  });

  it("stays quiet once enrolled, behind a gate (the gate already says it), or signed out", () => {
    expect(shouldNagForMfa({ mfaEnabled: true })).toBe(false);
    expect(shouldNagForMfa({ mfaEnabled: false, mfaEnrolmentRequired: true })).toBe(false);
    expect(shouldNagForMfa({ mfaEnabled: false, mustChangePassword: true })).toBe(false);
    expect(shouldNagForMfa(undefined)).toBe(false);
  });
});

describe("accountGateFromError", () => {
  const forbidden = (code?: string) => ({ response: { status: 403, data: { code, message: "no" } } });

  it("recognises the server's rotation and enrolment refusals", () => {
    expect(accountGateFromError(forbidden("PASSWORD_ROTATION_REQUIRED"))).toBe("password");
    expect(accountGateFromError(forbidden("MFA_ENROLMENT_REQUIRED"))).toBe("mfa");
  });

  it("ignores an ordinary 403 — a role refusal is not an account gate", () => {
    expect(accountGateFromError(forbidden())).toBeNull();
    expect(accountGateFromError({ response: { status: 400, data: { code: "PASSWORD_ROTATION_REQUIRED" } } })).toBeNull();
    expect(accountGateFromError(new Error("network"))).toBeNull();
  });
});
