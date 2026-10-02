/**
 * What the console says about the owner's company domain after provisioning a workspace — above all,
 * that a conflict is named rather than swallowed by a successful provision.
 */
import { describe, expect, it } from "vitest";
import { domainClaimNote } from "../../src/utils/domain-claim";

describe("domainClaimNote", () => {
  it("says the company's signups now come here", () => {
    expect(domainClaimNote({ outcome: "claimed", domain: "acme.com" })).toMatch(/@acme\.com/);
  });

  it("names the workspace that already holds the domain, and where to settle it", () => {
    const note = domainClaimNote({ outcome: "conflict", domain: "acme.com", heldBy: { id: "o", name: "Acme (2024)", slug: "acme-old" } });
    expect(note).toMatch(/Acme \(2024\)/);
    expect(note).toMatch(/Company domains/);
  });

  it("asks for a manual assignment when the claim failed", () => {
    expect(domainClaimNote({ outcome: "error", domain: null, detail: "x" })).toMatch(/Company domains/);
  });

  it("says nothing when there was nothing to claim, or signup already had", () => {
    expect(domainClaimNote({ outcome: "none", domain: null })).toBeNull();
    expect(domainClaimNote({ outcome: "already-held", domain: "acme.com" })).toBeNull();
    expect(domainClaimNote(undefined)).toBeNull();
  });
});
