/**
 * The console's small decisions that have to agree with the server: which account gate an operator
 * is behind, and how a gated 403 is recognised so the console can route to the form that lifts it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accountGateFromError, consoleAccountGate, isQueuedForApproval, issuedCredentialOf, shouldNagForMfa } from "../../src/lib/platform-console";

describe("issuedCredentialOf — the one time an approver sees a new operator's password", () => {
  it("finds the temporary password an approved admin.create or admin.reactivate returns", () => {
    expect(issuedCredentialOf({ action: "admin.create", result: { email: "new@x.test", name: "New", temporaryPassword: "Abc123def456!7aQ" } })).toEqual({
      email: "new@x.test",
      name: "New",
      temporaryPassword: "Abc123def456!7aQ"
    });
    expect(issuedCredentialOf({ action: "admin.reactivate", result: { email: "back@x.test", temporaryPassword: "Zyx987wvu654!7aQ" } })?.temporaryPassword).toBe("Zyx987wvu654!7aQ");
  });

  it("is nothing for an approval that issued no credential", () => {
    expect(issuedCredentialOf({ action: "retention.delete", result: { deleted: true } })).toBeNull();
    expect(issuedCredentialOf({ action: "admin.create", result: null })).toBeNull();
  });
});

/* Same lazy `read` helper the sibling guards use (see console-csv.test.ts for why it is a URL). */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("every page that calls a two-person route says when it was only queued (M2)", () => {
  // The API methods whose route can answer 202 with a queued request instead of doing the thing.
  const QUEUEING_CALLS = ["restoreBackup", "deleteBackup", "deleteUnderPolicy", "updateRetentionSettings", "createAdmin", "setAdminRole", "setAdminStatus"];
  const PAGES = ["Backups.tsx", "Retention.tsx", "Access.tsx"];

  for (const page of PAGES) {
    it(`${page} handles a queued answer wherever it calls one`, () => {
      const source = read(`../../src/pages/platform-admin/${page}`);
      const calls = QUEUEING_CALLS.filter((name) => source.includes(`.${name}(`));
      expect(calls.length, `${page} calls none of the queueing routes — drop it from this list`).toBeGreaterThan(0);
      expect(source, `${page} calls ${calls.join(", ")} but never says "Queued for approval"`).toMatch(/Queued for approval/);
      if (calls.some((name) => !["createAdmin", "setAdminRole"].includes(name))) {
        // Routes that answer EITHER done OR queued must look before they claim success.
        expect(source).toMatch(/isQueuedForApproval\(/);
      }
    });
  }
});

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
