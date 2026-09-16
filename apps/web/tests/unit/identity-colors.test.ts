/**
 * A project's mark must be the SAME colour everywhere and on every device, so the colour is a pure
 * function of the id. These pin that, the spread over the palette, and the initials rule.
 */
import { describe, expect, it } from "vitest";
import { hashKey, IDENTITY_COLORS, identityColorFor, initialsFor } from "../../src/lib/identity-colors";

describe("identityColorFor", () => {
  it("is stable for the same id and stays inside the palette", () => {
    const a = identityColorFor("f8f76597-5aca-46aa-88df-cae91a514749");
    expect(identityColorFor("f8f76597-5aca-46aa-88df-cae91a514749")).toEqual(a);
    expect(IDENTITY_COLORS).toContainEqual(a);
  });

  it("spreads a handful of similar uuids over more than one hue", () => {
    const ids = ["c7ad3ce5-e9c5-407d-bc9a-a0926eeb4367", "f8f76597-5aca-46aa-88df-cae91a514749", "c4959181-58f9-4f05-bdb3-6bf60568ef94", "6744b15d-ea10-466f-985d-e86288b080fc", "236ef386-1236-4302-99c1-92fea445d4a3"];
    const hues = new Set(ids.map((id) => identityColorFor(id).id));
    expect(hues.size).toBeGreaterThan(2);
  });

  it("hashes deterministically", () => {
    expect(hashKey("abc")).toBe(hashKey("abc"));
    expect(hashKey("abc")).not.toBe(hashKey("abd"));
  });
});

describe("initialsFor", () => {
  it("takes one letter for one word and two for more, ignoring separators", () => {
    expect(initialsFor("PropTech_ERP")).toBe("PE");
    expect(initialsFor("HICS Operations Platform")).toBe("HO");
    expect(initialsFor("Archive Drill")).toBe("AD");
    expect(initialsFor("web")).toBe("W");
    expect(initialsFor("  ")).toBe("•");
  });
});
