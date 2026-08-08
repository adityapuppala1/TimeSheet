/**
 * The capture middle path for capabilities that read attacker-adjacent text.
 *
 * The ROADMAP question was binary — denylist ci_failure_triage/security_finding_triage (breaking
 * dataset replay for exactly the capabilities that most need a golden set) or store raw secrets.
 * `redactSecrets` is the third option: structure survives, the credential does not. These tests
 * pin the shapes that matter — the ones a scanner itself would flag — and, just as importantly,
 * that ordinary prose passes through untouched, because a redactor that mangles normal text would
 * poison every dataset item it was meant to protect.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsDeep } from "../../src/services/ai.service.js";

describe("shapes that must be masked", () => {
  it("masks a PEM private key as one block", () => {
    const text = `context\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nfoo\n-----END RSA PRIVATE KEY-----\nafter`;
    const out = redactSecrets(text);
    expect(out).toContain("[REDACTED:private-key]");
    expect(out).not.toContain("MIIEow");
    // The surrounding context survives — that is what keeps the item replayable.
    expect(out).toContain("context");
    expect(out).toContain("after");
  });

  it("masks a JWT", () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`;
    expect(redactSecrets(`Authorization failed for ${jwt} at 10:32`)).not.toContain(jwt.slice(0, 20));
  });

  it("masks provider-prefixed tokens", () => {
    const out = redactSecrets(
      "found AKIAIOSFODNN7EXAMPLE and ghp_16C7e42F292c6912E7710c838347Ae178B4a and xoxb-1234567890-abcdefghij"
    );
    expect(out).toContain("[REDACTED:aws-key-id]");
    expect(out).toContain("[REDACTED:github-token]");
    expect(out).toContain("[REDACTED:slack-token]");
  });

  it("masks secret-looking assignments while keeping the key name", () => {
    // A gitleaks finding's title IS the leaked assignment — the key name is what makes the
    // finding classifiable, the value is what must not be stored.
    const out = redactSecrets(`Hardcoded api_key = "sk_live_abc123def456ghi789" in config.py`);
    expect(out).toContain("api_key");
    expect(out).not.toContain("sk_live_abc123def456ghi789");
  });

  it("masks bearer headers whatever the token shape", () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer abcdef0123456789abcdef'")).toContain("[REDACTED:bearer]");
  });
});

describe("what must survive", () => {
  it("leaves ordinary CI prose alone", () => {
    const log = "FAIL src/auth.test.ts — expected 200, received 500. 14 passed, 1 failed. Duration 32.1s";
    expect(redactSecrets(log)).toBe(log);
  });

  it("leaves a short git SHA alone — provenance is not a credential", () => {
    const line = "at commit 3f2a1b9 on branch fix/login";
    expect(redactSecrets(line)).toBe(line);
  });
});

describe("deep redaction", () => {
  it("walks params preserving structure, so the item stays replayable", () => {
    const params = {
      finding: { title: "password = hunter2secret99", severity: "HIGH" },
      tools: ["gitleaks"],
      count: 3
    };
    const out = redactSecretsDeep(params);
    expect(out.finding.severity).toBe("HIGH");
    expect(out.count).toBe(3);
    expect(out.tools).toEqual(["gitleaks"]);
    expect(out.finding.title).not.toContain("hunter2secret99");
  });
});
