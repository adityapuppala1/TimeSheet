/**
 * The console's small decisions that have to agree with the server: which account gate an operator
 * is behind, and how a gated 403 is recognised so the console can route to the form that lifts it.
 */
import { describe, expect, it } from "vitest";
import { accountGateFromError, consoleAccountGate } from "../../src/lib/platform-console";

describe("consoleAccountGate", () => {
  it("is the password form while the server says the password must change", () => {
    expect(consoleAccountGate({ mustChangePassword: true })).toBe("password");
  });

  it("is nothing for an ordinary signed-in operator", () => {
    expect(consoleAccountGate({ mustChangePassword: false })).toBeNull();
    expect(consoleAccountGate(undefined)).toBeNull();
  });
});

describe("accountGateFromError", () => {
  const forbidden = (code?: string) => ({ response: { status: 403, data: { code, message: "no" } } });

  it("recognises the server's rotation refusal", () => {
    expect(accountGateFromError(forbidden("PASSWORD_ROTATION_REQUIRED"))).toBe("password");
  });

  it("ignores an ordinary 403 — a role refusal is not an account gate", () => {
    expect(accountGateFromError(forbidden())).toBeNull();
    expect(accountGateFromError({ response: { status: 400, data: { code: "PASSWORD_ROTATION_REQUIRED" } } })).toBeNull();
    expect(accountGateFromError(new Error("network"))).toBeNull();
  });
});
