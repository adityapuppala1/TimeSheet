/**
 * The decisions the signup page makes from what the server says — kept out of the component so each
 * one is pinned here, because each is a way the page offers the wrong door:
 *  - verify's answer picks the next step, and only `join`/`create` carry on with a continuation;
 *  - the workspace address preview is `<slug>.<rootDomain>` from the server, never guessed from
 *    the page's own host (the page is served from the apex AND from any workspace's host);
 *  - each refusal lands where the person can act on it: a taken address on the field, a domain
 *    claimed a moment ago back at the code step, an expired verification back at the start.
 */
import { describe, expect, it } from "vitest";
import { classifySignupError, companyWorkspaceLabel, contactPrefill, stepAfterVerify, workspaceHostSuffix } from "../../src/utils/signup-flow";

const axiosError = (status: number, data: Record<string, unknown> = {}) => ({ response: { status, data } });

describe("stepAfterVerify", () => {
  it("routes each server decision to its own step", () => {
    expect(stepAfterVerify({ next: "member", workspaces: [] })).toBe("member");
    expect(stepAfterVerify({ next: "join", workspace: { name: "Acme" }, continuation: "c" })).toBe("join");
    expect(stepAfterVerify({ next: "unavailable", workspace: { name: "Acme" } })).toBe("unavailable");
    expect(stepAfterVerify({ next: "create", continuation: "c" })).toBe("workspace");
  });
});

describe("workspaceHostSuffix", () => {
  it("is the deployment's root domain from the server", () => {
    expect(workspaceHostSuffix("timesphere.app")).toBe(".timesphere.app");
    expect(workspaceHostSuffix("TimeSphere.App.")).toBe(".timesphere.app");
  });

  it("is nothing at all when the server names no root domain — never a guess", () => {
    expect(workspaceHostSuffix(null)).toBeNull();
    expect(workspaceHostSuffix(undefined)).toBeNull();
    expect(workspaceHostSuffix("")).toBeNull();
  });
});

describe("classifySignupError", () => {
  it("treats SIGNUP_CLOSED as the closed state, not an error", () => {
    expect(classifySignupError(axiosError(403, { code: "SIGNUP_CLOSED" }))).toEqual({ kind: "closed" });
  });

  it("puts a taken address on the field and keeps the person on the form", () => {
    expect(classifySignupError(axiosError(409, { code: "SLUG_TAKEN", message: "Taken." }))).toEqual({ kind: "slug-taken", message: "Taken." });
  });

  it("sends a domain claimed — or a workspace gone — since verify back to verify, where the answer changes", () => {
    // The code was spent at verify, so "back" means a fresh code: create becomes join, join becomes create.
    expect(classifySignupError(axiosError(409, { code: "DOMAIN_CLAIMED", message: "Someone…" })).kind).toBe("verify-again");
    expect(classifySignupError(axiosError(409, { code: "NO_WORKSPACE", message: "Gone." })).kind).toBe("verify-again");
  });

  it("shows the unavailable state when the company's workspace stopped being ACTIVE since verify", () => {
    expect(classifySignupError(axiosError(409, { code: "WORKSPACE_UNAVAILABLE", message: "Not now." }))).toEqual({ kind: "unavailable" });
  });

  it("sends an expired verification back to the start", () => {
    expect(classifySignupError(axiosError(400, { code: "SIGNUP_EXPIRED", message: "Expired." })).kind).toBe("expired");
  });

  it("sends a failed provisioning back to the start too — its continuation is spent, so a retry from here cannot work", () => {
    expect(classifySignupError(axiosError(502, { code: "PROVISIONING_FAILED", message: "Start again." }))).toEqual({ kind: "expired", message: "Start again." });
  });

  it("names the throttle, because the limiter's own body says nothing useful", () => {
    expect(classifySignupError(axiosError(429)).kind).toBe("message");
    expect((classifySignupError(axiosError(429)) as { message: string }).message).toMatch(/wait/i);
  });

  it("keeps the server's own 429 message — too many wrong codes is not the network limiter", () => {
    expect(classifySignupError(axiosError(429, { message: "Too many attempts. Request a new code." }))).toEqual({
      kind: "message",
      message: "Too many attempts. Request a new code."
    });
  });

  it("passes any other server message through, with a fallback when there is none", () => {
    expect(classifySignupError(axiosError(422, { message: "Use your work email." }))).toEqual({ kind: "message", message: "Use your work email." });
    expect(classifySignupError(new Error("Network Error"), "Couldn't send.")).toEqual({ kind: "message", message: "Couldn't send." });
  });
});

describe("companyWorkspaceLabel", () => {
  it("names the company's workspace when the server named it, and says something true when it did not", () => {
    expect(companyWorkspaceLabel("Northwind")).toBe("Northwind's workspace");
    // /complete's WORKSPACE_UNAVAILABLE carries no name — never render "'s workspace".
    expect(companyWorkspaceLabel("")).toBe("Your company's workspace");
  });
});

describe("contactPrefill", () => {
  it("starts the message for someone whose company already has a workspace but needs its own", () => {
    expect(contactPrefill("separate-workspace")).toMatch(/separate workspace/i);
  });

  it("starts nothing for an unknown or absent reason", () => {
    expect(contactPrefill(null)).toBe("");
    expect(contactPrefill("<script>")).toBe("");
  });
});
