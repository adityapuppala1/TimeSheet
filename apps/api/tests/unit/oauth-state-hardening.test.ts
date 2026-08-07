/**
 * The two short-lived signed `state` tokens that carry org identity through an external
 * redirect: SSO's (services/sso.service.ts) and the GitHub connect flow's
 * (services/git-provider.service.ts).
 *
 * Both used to verify without pinning `algorithms`, the one place the rule utils/security.ts
 * states for every other verify in this app was not followed — jsonwebtoken then infers the
 * acceptable set from the KEY TYPE, so the token's own header gets a vote it should never have.
 *
 * The GitHub one additionally used to be replayable: signed, but not single-use, so a state that
 * leaked the way redirect URLs leak (Referer, proxy log, browser history) could be spent a second
 * time inside its 10-minute window to bind an ATTACKER's GitHub token into the VICTIM's org.
 */
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it } from "vitest";

const { signSsoState, verifySsoState } = await import("../../src/services/sso.service.js");
const { signGitConnectState, verifyGitConnectState } = await import("../../src/services/git-provider.service.js");
const { resetWebhookReplayStore } = await import("../../src/services/webhook-replay.js");

const SECRET = process.env.JWT_ACCESS_SECRET as string;

/** A token an attacker can mint with nothing but the same shared secret, differing from ours only
 *  in the `alg` header — which is exactly the header a verify without `algorithms` trusts. */
const signWith = (algorithm: jwt.Algorithm, issuer: string, payload: object) =>
  jwt.sign(payload, SECRET, { algorithm, issuer, expiresIn: 600 });

beforeEach(() => {
  resetWebhookReplayStore();
});

describe("state verification pins its algorithm", () => {
  it("verifySsoState accepts the algorithm we sign with", () => {
    const state = signSsoState({ orgId: "org-1", provider: "SAML" });
    expect(verifySsoState(state).orgId).toBe("org-1");
  });

  it("verifySsoState refuses a state whose header picked a different algorithm", () => {
    const forged = signWith("HS512", "timesphere-sso", { orgId: "org-1", provider: "SAML" });
    expect(() => verifySsoState(forged)).toThrow(/expired or is invalid/i);
  });

  it("verifyGitConnectState refuses a state whose header picked a different algorithm", () => {
    const forged = signWith("HS512", "timesphere-git", { orgId: "org-1", userId: "user-1", jti: "nonce-1" });
    expect(() => verifyGitConnectState(forged)).toThrow(/expired or is invalid/i);
  });

  it("still refuses a state signed for the other flow's issuer", () => {
    const crossed = signWith("HS256", "timesphere-sso", { orgId: "org-1", userId: "user-1", jti: "nonce-2" });
    expect(() => verifyGitConnectState(crossed)).toThrow(/expired or is invalid/i);
  });
});

describe("the GitHub connect state is single-use", () => {
  it("verifies once and refuses the same state after", () => {
    const state = signGitConnectState({ orgId: "org-1", userId: "user-1" });

    expect(verifyGitConnectState(state)).toEqual({ orgId: "org-1", userId: "user-1" });
    // The replay: same bytes, same signature, still inside the 10-minute window.
    expect(() => verifyGitConnectState(state)).toThrow(/expired or is invalid/i);
  });

  it("gives a replayed state the same rejection as a garbage one, disclosing nothing", () => {
    const state = signGitConnectState({ orgId: "org-1", userId: "user-1" });
    verifyGitConnectState(state);

    const replayed = (() => {
      try {
        verifyGitConnectState(state);
      } catch (error) {
        return error as Error & { statusCode: number };
      }
      throw new Error("replay unexpectedly succeeded");
    })();
    const garbage = (() => {
      try {
        verifyGitConnectState("not-a-token");
      } catch (error) {
        return error as Error & { statusCode: number };
      }
      throw new Error("garbage unexpectedly succeeded");
    })();

    expect(replayed.statusCode).toBe(garbage.statusCode);
    expect(replayed.message).toBe(garbage.message);
  });

  it("spending one org's state leaves another org's untouched", () => {
    const first = signGitConnectState({ orgId: "org-1", userId: "user-1" });
    const second = signGitConnectState({ orgId: "org-2", userId: "user-2" });

    verifyGitConnectState(first);
    expect(verifyGitConnectState(second)).toEqual({ orgId: "org-2", userId: "user-2" });
  });

  it("refuses a state minted before the nonce claim existed rather than trusting it", () => {
    // Exactly what signGitConnectState used to produce: valid signature, valid issuer, no jti.
    const legacy = signWith("HS256", "timesphere-git", { orgId: "org-1", userId: "user-1" });
    expect(() => verifyGitConnectState(legacy)).toThrow(/expired or is invalid/i);
  });
});
